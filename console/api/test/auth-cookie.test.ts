import { describe, expect, it } from "vitest";
import {
  clearedRefreshCookie,
  readRefreshCookie,
  refreshCookie,
  REFRESH_COOKIE,
} from "../src/lib/auth-cookie.js";

/**
 * The cookie the refresh token lives in.
 *
 * Every attribute here is load-bearing, so each is asserted rather than the
 * string as a whole: a missing `HttpOnly` is invisible until an XSS carries the
 * token off, and a missing `Secure` looks exactly like a working login until the
 * browser silently drops it.
 */

describe("refreshCookie", () => {
  const cookie = refreshCookie("tok", { maxAge: 60 });

  it("is not readable by script", () => {
    expect(cookie).toContain("HttpOnly");
  });

  it("is not sent cross-site", () => {
    // Affordable because the console and API share an origin, so cross-site is
    // never a case we need to serve.
    expect(cookie).toContain("SameSite=Strict");
  });

  it("rides only on API calls", () => {
    // The path the browser sees. CloudFront strips the prefix before the origin,
    // so this is deliberately not the path the Lambda receives.
    expect(cookie).toContain("Path=/api");
  });

  it("expires with the token it carries", () => {
    expect(cookie).toContain("Max-Age=60");
  });

  it("requires https by default", () => {
    expect(cookie).toContain("Secure");
  });

  it("drops Secure only when asked, for plain-http localhost", () => {
    // A Secure cookie on an http origin is discarded silently, which presents as
    // a login that works and then forgets you on the next request.
    expect(refreshCookie("tok", { maxAge: 60, secure: false })).not.toContain(
      "Secure",
    );
  });
});

describe("clearedRefreshCookie", () => {
  it("expires the cookie immediately", () => {
    expect(clearedRefreshCookie()).toContain("Max-Age=0");
  });

  it("keeps the attributes it was set with", () => {
    // A browser matches on name plus path; clearing with a different path leaves
    // the original in place and the user stays signed in after logging out.
    const cleared = clearedRefreshCookie();

    expect(cleared).toContain("Path=/api");
    expect(cleared).toContain("SameSite=Strict");
    expect(cleared).toContain("HttpOnly");
  });
});

describe("readRefreshCookie", () => {
  it("finds the token among other cookies", () => {
    expect(readRefreshCookie(`other=1; ${REFRESH_COOKIE}=tok; another=2`)).toBe(
      "tok",
    );
  });

  it("keeps a value containing =", () => {
    // Only the first = separates name from value; base64 padding is legal here.
    expect(readRefreshCookie(`${REFRESH_COOKIE}=a=b==`)).toBe("a=b==");
  });

  it("is empty when the cookie is absent", () => {
    expect(readRefreshCookie("other=1")).toBe("");
    expect(readRefreshCookie(undefined)).toBe("");
  });

  it("does not match a cookie whose name merely ends with ours", () => {
    expect(readRefreshCookie(`not_${REFRESH_COOKIE}=tok`)).toBe("");
  });
});
