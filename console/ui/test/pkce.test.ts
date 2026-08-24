import { beforeEach, describe, expect, it } from "vitest";
import {
  authorizeUrl,
  base64Url,
  challengeFor,
  newPendingLogin,
  savePendingLogin,
  takePendingLogin,
} from "../src/auth/pkce";

/**
 * Starting a login and proving the code came back to the tab that asked.
 *
 * The unit config has no DOM, so `sessionStorage` is stubbed — it is a two-method
 * interface and the behaviour worth testing is what we put in and take out of
 * it, not the browser's implementation of it.
 */

class MemoryStorage {
  private data = new Map<string, string>();
  getItem = (key: string) => this.data.get(key) ?? null;
  setItem = (key: string, value: string) => void this.data.set(key, value);
  removeItem = (key: string) => void this.data.delete(key);
}

beforeEach(() => {
  Object.defineProperty(globalThis, "sessionStorage", {
    value: new MemoryStorage(),
    configurable: true,
  });
});

describe("base64Url", () => {
  it("uses the URL-safe alphabet and drops padding", () => {
    // Plain base64 would put + / and = into a query string, where they are
    // re-encoded and no longer match what the API forwards to Cognito.
    const encoded = base64Url(new Uint8Array([251, 255, 190, 255]));

    expect(encoded).not.toMatch(/[+/=]/);
  });
});

describe("challengeFor", () => {
  it("is the S256 digest of the verifier", async () => {
    // The published example from RFC 7636, so this checks the algorithm rather
    // than merely checking it is stable.
    const challenge = await challengeFor(
      "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    );

    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("differs for different verifiers", async () => {
    expect(await challengeFor("a")).not.toBe(await challengeFor("b"));
  });
});

describe("newPendingLogin", () => {
  it("is long enough to be a valid verifier", () => {
    // PKCE requires at least 43 characters once encoded.
    expect(newPendingLogin("/console").verifier.length).toBeGreaterThanOrEqual(
      43,
    );
  });

  it("is different every time", () => {
    const a = newPendingLogin("/console");
    const b = newPendingLogin("/console");

    expect(a.verifier).not.toBe(b.verifier);
    expect(a.state).not.toBe(b.state);
  });

  it("remembers where the user was going", () => {
    expect(newPendingLogin("/console/hosts/www.example.com").returnTo).toBe(
      "/console/hosts/www.example.com",
    );
  });
});

describe("the pending login round trip", () => {
  it("comes back as it went in", () => {
    const pending = newPendingLogin("/console");
    savePendingLogin(pending);

    expect(takePendingLogin()).toEqual(pending);
  });

  it("can only be taken once", () => {
    // A login round trip is single-use; leaving it behind would let a replayed
    // callback URL be accepted a second time.
    savePendingLogin(newPendingLogin("/console"));
    takePendingLogin();

    expect(takePendingLogin()).toBeUndefined();
  });

  it("is undefined when no login is in progress", () => {
    expect(takePendingLogin()).toBeUndefined();
  });

  it("is undefined for a value that is not one of ours", () => {
    // Another tool's data under the same key, or a half-written value. Landing
    // on "no login in progress" beats throwing on a page the user can see.
    sessionStorage.setItem("edgeroute.auth.pending", "not json");
    expect(takePendingLogin()).toBeUndefined();

    sessionStorage.setItem("edgeroute.auth.pending", '{"verifier":1}');
    expect(takePendingLogin()).toBeUndefined();
  });
});

describe("authorizeUrl", () => {
  const url = authorizeUrl({
    domain: "https://pool.auth.us-east-1.amazoncognito.com",
    clientId: "client-1",
    redirectUri: "http://localhost:5180/auth/callback",
    state: "state-1",
    challenge: "challenge-1",
  });

  it("asks for a code, not a token", () => {
    // The implicit flow would return tokens in the URL fragment, where they land
    // in history and in any referrer.
    expect(url).toContain("response_type=code");
  });

  it("carries the PKCE challenge and its method", () => {
    expect(url).toContain("code_challenge=challenge-1");
    expect(url).toContain("code_challenge_method=S256");
  });

  it("encodes the redirect URI rather than splicing it in raw", () => {
    expect(url).toContain(
      `redirect_uri=${encodeURIComponent("http://localhost:5180/auth/callback")}`,
    );
  });

  it("carries the state that is checked on return", () => {
    expect(url).toContain("state=state-1");
  });
});
