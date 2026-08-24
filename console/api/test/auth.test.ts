import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { handler } from "../src/handler.js";
import { resetCognitoFetch, setCognitoFetch } from "../src/lib/cognito.js";
import { REFRESH_COOKIE } from "../src/lib/auth-cookie.js";

/**
 * The three routes that issue and end a session.
 *
 * Driven through `handler` rather than the exported functions, because the parts
 * worth protecting are on the edges: that the route is reachable without a
 * token, and that the refresh token leaves as a `Set-Cookie` and not in the body.
 */

const TOKENS = {
  access_token: "access-1",
  id_token: "id-1",
  refresh_token: "refresh-1",
  expires_in: 3600,
};

let calls: { url: string; body: string; auth: string }[] = [];

/** Stands in for Cognito's token endpoint. */
const respondWith = (status: number, payload: unknown): void => {
  setCognitoFetch(((url: string, init: RequestInit) => {
    calls.push({
      url: String(url),
      body: String(init.body ?? ""),
      auth: String(
        (init.headers as Record<string, string> | undefined)?.authorization ??
          "",
      ),
    });
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as unknown as typeof globalThis.fetch);
};

const event = (
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): APIGatewayProxyEventV2 =>
  ({
    rawPath: path,
    headers: { host: "console.example.com", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: { http: { method: "POST" } },
  }) as unknown as APIGatewayProxyEventV2;

const parse = (body: string | undefined): Record<string, unknown> =>
  JSON.parse(body ?? "null") as Record<string, unknown>;

beforeEach(() => {
  calls = [];
  process.env.COGNITO_USER_POOL_ID = "pool-1";
  process.env.COGNITO_CLIENT_ID = "client-1";
  process.env.COGNITO_CLIENT_SECRET = "secret-1";
  process.env.COGNITO_DOMAIN = "https://pool.auth.us-east-1.amazoncognito.com";
});

afterEach(() => {
  resetCognitoFetch();
  delete process.env.COGNITO_USER_POOL_ID;
  delete process.env.COGNITO_CLIENT_ID;
  delete process.env.COGNITO_CLIENT_SECRET;
  delete process.env.COGNITO_DOMAIN;
});

describe("POST /auth/session", () => {
  it("is reachable without a token", async () => {
    // The circularity the public flag exists for: you call this to get a token.
    respondWith(200, TOKENS);

    const res = await handler(
      event("/auth/session", { code: "c", redirectUri: "https://x/cb" }),
    );

    expect(res.statusCode).toBe(200);
  });

  it("returns the access token but never the refresh token", async () => {
    // The whole point of the cookie: an XSS can act as the user while the tab is
    // open, but has nothing to carry away and reuse later.
    respondWith(200, TOKENS);

    const res = await handler(
      event("/auth/session", { code: "c", redirectUri: "https://x/cb" }),
    );
    const body = parse(res.body);

    expect(body.accessToken).toBe("access-1");
    expect(JSON.stringify(body)).not.toContain("refresh-1");
  });

  it("sets the refresh token as an HttpOnly cookie", async () => {
    respondWith(200, TOKENS);

    const res = await handler(
      event("/auth/session", { code: "c", redirectUri: "https://x/cb" }),
    );

    expect(res.cookies?.[0]).toContain(`${REFRESH_COOKIE}=refresh-1`);
    expect(res.cookies?.[0]).toContain("HttpOnly");
    expect(res.cookies?.[0]).toContain("Secure");
  });

  it("authenticates to the token endpoint with the client secret", async () => {
    // What the secret is for: it proves the exchange came from the API and not
    // from whoever intercepted the code.
    respondWith(200, TOKENS);

    await handler(
      event("/auth/session", { code: "c", redirectUri: "https://x/cb" }),
    );

    const expected = Buffer.from("client-1:secret-1").toString("base64");
    expect(calls[0].auth).toBe(`Basic ${expected}`);
    expect(calls[0].url).toContain("/oauth2/token");
  });

  it("sends the redirect URI back for the endpoint to compare", async () => {
    respondWith(200, TOKENS);

    await handler(
      event("/auth/session", { code: "c", redirectUri: "https://x/cb" }),
    );

    expect(calls[0].body).toContain("redirect_uri=https%3A%2F%2Fx%2Fcb");
    expect(calls[0].body).toContain("grant_type=authorization_code");
  });

  it("forwards a PKCE verifier when the login used one", async () => {
    respondWith(200, TOKENS);

    await handler(
      event("/auth/session", {
        code: "c",
        redirectUri: "https://x/cb",
        codeVerifier: "v-1",
      }),
    );

    expect(calls[0].body).toContain("code_verifier=v-1");
  });

  it("400s without a code", async () => {
    const res = await handler(event("/auth/session", { redirectUri: "x" }));

    expect(res.statusCode).toBe(400);
  });

  it("401s a rejected code without repeating why", async () => {
    // Cognito distinguishes expired from unknown; passing that back tells an
    // attacker which of their guesses was shaped correctly.
    respondWith(400, { error: "invalid_grant" });

    const res = await handler(
      event("/auth/session", { code: "bad", redirectUri: "https://x/cb" }),
    );

    expect(res.statusCode).toBe(401);
    expect(JSON.stringify(parse(res.body))).not.toContain("invalid_grant");
  });

  it("drops Secure on plain-http localhost", async () => {
    // Otherwise the browser discards the cookie and local dev cannot stay
    // signed in through a reload.
    respondWith(200, TOKENS);

    const res = await handler(
      event(
        "/auth/session",
        { code: "c", redirectUri: "http://localhost:5180/cb" },
        { host: "localhost:3000" },
      ),
    );

    expect(res.cookies?.[0]).not.toContain("Secure");
  });
});

describe("POST /auth/refresh", () => {
  it("401s with no cookie, which is the signed-out answer", async () => {
    const res = await handler(event("/auth/refresh"));

    expect(res.statusCode).toBe(401);
  });

  it("mints a new access token from the cookie", async () => {
    respondWith(200, { ...TOKENS, access_token: "access-2" });

    const res = await handler(
      event("/auth/refresh", undefined, {
        cookie: `${REFRESH_COOKIE}=refresh-1`,
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(parse(res.body).accessToken).toBe("access-2");
    expect(calls[0].body).toContain("grant_type=refresh_token");
  });

  it("clears a refresh token the provider rejected", async () => {
    // It will never work again, so leaving it set means retrying with it on
    // every load.
    respondWith(400, { error: "invalid_grant" });

    const res = await handler(
      event("/auth/refresh", undefined, {
        cookie: `${REFRESH_COOKIE}=stale`,
      }),
    );

    expect(res.statusCode).toBe(401);
    expect(res.cookies?.[0]).toContain("Max-Age=0");
  });
});

describe("POST /auth/logout", () => {
  it("clears the cookie and says where to finish signing out", async () => {
    // Both halves: the provider keeps its own session, so clearing ours alone
    // lets the next sign-in through with no prompt.
    const res = await handler(
      event("/auth/logout", { returnTo: "https://console.example.com/login" }),
    );
    const body = parse(res.body);

    expect(res.statusCode).toBe(200);
    expect(res.cookies?.[0]).toContain("Max-Age=0");
    expect(String(body.logoutUrl)).toContain("/logout?client_id=client-1");
    expect(String(body.logoutUrl)).toContain(
      encodeURIComponent("https://console.example.com/login"),
    );
  });

  it("400s without a return URL", async () => {
    const res = await handler(event("/auth/logout", {}));

    expect(res.statusCode).toBe(400);
  });
});
