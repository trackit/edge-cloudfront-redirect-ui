/**
 * The access token, and keeping it fresh.
 *
 * Held in a closure rather than in `localStorage`, so a script that gets into
 * the page can use it while the tab is open but cannot copy it out to use later.
 * The cost is that a reload starts with nothing, which is why `bootstrap` exists:
 * the only way to know whether the visitor is signed in is to ask the API, using
 * the HttpOnly cookie the browser sends on its own.
 */

export interface SessionApi {
  /** POST /auth/refresh. Rejects when there is no usable session. */
  refresh(): Promise<{ accessToken: string; expiresIn: number }>;
}

export interface Session {
  accessToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/**
 * How long before expiry a token is treated as due for renewal.
 *
 * A request that starts just under the wire can still arrive just over it, and
 * clocks between the browser and AWS are not identical. Renewing a minute early
 * costs nothing and removes both problems.
 */
export const RENEW_MARGIN_MS = 60_000;

export const isFresh = (session: Session | undefined, now: number): boolean =>
  session !== undefined && session.expiresAt - RENEW_MARGIN_MS > now;

export const expiryFrom = (expiresIn: number, now: number): number =>
  now + expiresIn * 1000;

export interface SessionStore {
  /** A usable access token, renewing first if the current one is close to expiry. */
  token(): Promise<string | undefined>;
  /** Forces a renewal even if the current token still looks fresh. */
  renew(): Promise<string | undefined>;
  /** Drops the in-memory token. The cookie is cleared by the API, not here. */
  clear(): void;
  /** What is held right now, without triggering a network call. */
  current(): Session | undefined;
}

export const createSessionStore = (
  api: SessionApi,
  now: () => number = Date.now,
): SessionStore => {
  let session: Session | undefined;

  /**
   * The one renewal in flight, shared by every caller that asks while it runs.
   *
   * Without this, a page that fires four requests on load starts four refreshes.
   * That is wasteful with rotation off and fatal with it on — each new refresh
   * token invalidates the last, so the four would race and the losers would log
   * the user out.
   */
  let inFlight: Promise<string | undefined> | undefined;

  const renew = (): Promise<string | undefined> => {
    inFlight ??= api
      .refresh()
      .then(({ accessToken, expiresIn }) => {
        session = { accessToken, expiresAt: expiryFrom(expiresIn, now()) };
        return accessToken;
      })
      .catch(() => {
        // Not an error to report: "no session" is the ordinary answer for a
        // signed-out visitor, and the guard reads it from `current()`.
        session = undefined;
        return undefined;
      })
      .finally(() => {
        inFlight = undefined;
      });

    return inFlight;
  };

  return {
    async token() {
      if (isFresh(session, now())) return session?.accessToken;
      return renew();
    },
    renew,
    clear() {
      session = undefined;
    },
    current: () => session,
  };
};
