/**
 * The refresh token's cookie.
 *
 * The refresh token is the one credential worth stealing — it mints access
 * tokens until it expires — so it is the one thing the browser is never allowed
 * to read. `HttpOnly` is what makes that true: script in the page cannot see it,
 * so an XSS can act as the user for as long as the tab is open but cannot carry
 * anything away to use later from somewhere else.
 *
 * `SameSite=Strict` is affordable because the console and the API share an
 * origin — the SPA calls a relative `/api`, and CloudFront routes `/api/*` to
 * the API behind the same distribution. Cross-site is therefore never a case we
 * need to serve, so it is a case we can refuse outright.
 */
export const REFRESH_COOKIE = "edgeroute_refresh";

/**
 * `Path=/api` is the path the *browser* sees, not the one the Lambda does:
 * CloudFront strips the prefix before the origin. Scoping it means the cookie
 * rides only on API calls and is absent from every request for the SPA itself.
 */
const COOKIE_PATH = "/api";

export interface CookieOptions {
  /** Seconds. Matches the refresh token's own lifetime so the two expire together. */
  maxAge: number;
  /**
   * Off only for local dev over plain http. `Secure` on a localhost http origin
   * makes the browser drop the cookie silently, which looks exactly like a
   * broken login.
   */
  secure?: boolean;
}

export const refreshCookie = (
  value: string,
  { maxAge, secure = true }: CookieOptions,
): string =>
  [
    `${REFRESH_COOKIE}=${value}`,
    "HttpOnly",
    ...(secure ? ["Secure"] : []),
    "SameSite=Strict",
    `Path=${COOKIE_PATH}`,
    `Max-Age=${maxAge}`,
  ].join("; ");

/**
 * The same cookie, expired. Overwriting with `Max-Age=0` is what clears it —
 * the attributes have to match the ones it was set with or the browser treats it
 * as a different cookie and leaves the original in place.
 */
export const clearedRefreshCookie = (secure = true): string =>
  refreshCookie("", { maxAge: 0, secure });

/**
 * Reads the refresh token out of a Cookie header.
 *
 * Hand-parsed rather than split on `;` alone: a value may legally contain `=`,
 * so only the first one separates name from value.
 */
export const readRefreshCookie = (header: string | undefined): string => {
  if (header === undefined) return "";

  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) !== REFRESH_COOKIE) continue;
    return trimmed.slice(eq + 1);
  }
  return "";
};
