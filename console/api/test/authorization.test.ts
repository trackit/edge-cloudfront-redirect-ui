import { describe, expect, it } from "vitest";
import { createRouter } from "../src/router.js";
import { routes } from "../src/routes.js";
import type { ApiRequest } from "../src/context.js";
import type { Route } from "../src/router.js";
import { ApiError } from "../src/lib/errors.js";

/**
 * Who may reach what.
 *
 * The gateway refuses a request with no valid token, so in production nothing
 * without a principal arrives here. These cases are the second statement of the
 * same rule: if the authorizer were ever detached — a route added without one, a
 * stage misconfigured — the Lambda still refuses rather than serving the control
 * plane to anyone who asks.
 */

const ok = { status: 200, body: {} };

const req = (over: Partial<ApiRequest> = {}): ApiRequest => ({
  method: "GET",
  path: "/thing",
  params: {},
  query: {},
  headers: {},
  body: undefined,
  ...over,
});

const editor = { sub: "u", groups: ["editor"] };
const viewer = { sub: "u", groups: ["viewer"] };
const roleless = { sub: "u", groups: [] };

const table: Route[] = [
  { method: "GET", pattern: "/open", handler: () => ok, public: true },
  { method: "GET", pattern: "/thing", handler: () => ok },
  { method: "POST", pattern: "/thing", handler: () => ok, write: true },
];

const router = createRouter(table);

const statusOf = async (request: ApiRequest): Promise<number> => {
  try {
    return (await router.handle(request)).status;
  } catch (caught) {
    if (caught instanceof ApiError) return caught.status;
    throw caught;
  }
};

describe("a request with no principal", () => {
  it("reaches a public route", async () => {
    // /health has to answer an uptime check that holds no token.
    expect(await statusOf(req({ path: "/open" }))).toBe(200);
  });

  it("is refused on a protected route, even a read", async () => {
    expect(await statusOf(req())).toBe(401);
  });

  it("is refused before the handler runs", async () => {
    // The check has to precede dispatch: a handler that reads the target
    // registry has already leaked its contents by the time it returns.
    let ran = false;
    const guarded = createRouter([
      {
        method: "GET",
        pattern: "/thing",
        handler: () => {
          ran = true;
          return ok;
        },
      },
    ]);

    await expect(guarded.handle(req())).rejects.toThrow(ApiError);
    expect(ran).toBe(false);
  });
});

describe("a viewer", () => {
  it("may read", async () => {
    expect(await statusOf(req({ principal: viewer }))).toBe(200);
  });

  it("is forbidden from writing", async () => {
    expect(await statusOf(req({ method: "POST", principal: viewer }))).toBe(
      403,
    );
  });

  it("is told signing in again will not help", async () => {
    // 403 rather than 401 is the whole message: the console offers "sign in" as
    // the remedy for one and not the other.
    await expect(
      router.handle(req({ method: "POST", principal: viewer })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("an editor", () => {
  it("may read and write", async () => {
    expect(await statusOf(req({ principal: editor }))).toBe(200);
    expect(await statusOf(req({ method: "POST", principal: editor }))).toBe(
      200,
    );
  });
});

describe("a user in no role group", () => {
  it("may not write", async () => {
    expect(await statusOf(req({ method: "POST", principal: roleless }))).toBe(
      403,
    );
  });

  it("may still read", async () => {
    // The deliberate line: authenticated with no role can look but not touch.
    // Tightening this to 403 is a one-word change in `authorize`, and this case
    // is where that decision is recorded.
    expect(await statusOf(req({ principal: roleless }))).toBe(200);
  });
});

describe("the real route table", () => {
  it("marks every state-changing route as a write", async () => {
    // The flag is the whole of role-based access, so a route added without it is
    // a route a viewer can call. Derived from the method rather than listed, so
    // this keeps holding as routes are added.
    //
    // Public routes are exempt because there is no role to check: they run
    // before anyone has a token. That is the auth exchange itself, and it is a
    // small enough set that the case below names every member.
    const unflagged = routes.filter(
      (route) =>
        ["POST", "PUT", "PATCH", "DELETE"].includes(route.method) &&
        route.public !== true &&
        route.write !== true,
    );

    expect(
      unflagged.map((route) => `${route.method} ${route.pattern}`),
    ).toEqual([]);
  });

  it("exposes only health without a token", async () => {
    // Every addition here is reachable by anyone on the internet, so it should
    // take a deliberate edit to this list rather than a quiet flag on a route.
    const open = routes
      .filter((route) => route.public === true)
      .map((route) => `${route.method} ${route.pattern}`);

    expect(open).toEqual([
      "GET /health",
      // The three below issue a session, so requiring one would be circular.
      // Each is still gated on something only a real login produces: an
      // authorization code, or the HttpOnly cookie this API set.
      "POST /auth/session",
      "POST /auth/refresh",
      "POST /auth/logout",
    ]);
  });

  it("leaves every read route protected", async () => {
    const readable = routes.filter(
      (route) => route.method === "GET" && route.public !== true,
    );

    expect(readable.length).toBeGreaterThan(0);
    expect(readable.every((route) => route.write !== true)).toBe(true);
  });
});
