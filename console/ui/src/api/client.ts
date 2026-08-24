import { ApiError, toApiError } from "./error";
import type {
  HostSummary,
  Session,
  Rule,
  RuleInput,
  Target,
  TargetInput,
  TargetUpdate,
} from "./types";

export interface ApiClientOptions {
  /** Overrides `VITE_API_BASE_URL`. Trailing slashes are trimmed. */
  baseUrl?: string;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /**
   * Supplies the bearer token, renewing it first if it is close to expiry.
   *
   * A function rather than a string because the token changes underneath the
   * client: it lives for an hour and the session store replaces it. Reading it
   * per request is what keeps a long-lived client from holding a stale one.
   *
   * `force` skips the freshness check and renews regardless. The 401 retry needs
   * it: a token the API has already rejected can still look fresh here, so
   * asking politely would hand back the same rejected token.
   */
  getToken?: (force?: boolean) => Promise<string | undefined>;
}

const DEFAULT_BASE_URL = "/api";

const trimTrailingSlash = (url: string): string => url.replace(/\/+$/, "");

/**
 * Percent-encodes one path segment.
 *
 * This matters most for `sk`. A sort key is `REDIRECT#00100`, and `#` starts the
 * fragment in a URL — sent raw, everything from the `#` is stripped by the
 * browser and the server sees `/rules/REDIRECT`, which 400s as a malformed key.
 * Hosts are encoded for the same reason, since nothing stops a host from
 * carrying a character with URL meaning.
 */
const segment = (value: string): string => encodeURIComponent(value);

/**
 * Typed client for the console API.
 *
 * Every method resolves to the response body, or throws `ApiError`. Nothing here
 * retries: a rule write is not idempotent (`createRule` 409s on a duplicate
 * priority), so retrying belongs to the caller that knows whether repeating is
 * safe.
 */
export function createApiClient(options: ApiClientOptions = {}) {
  const baseUrl = trimTrailingSlash(
    options.baseUrl ?? import.meta.env.VITE_API_BASE_URL ?? DEFAULT_BASE_URL,
  );
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const getToken = options.getToken ?? (() => Promise.resolve(undefined));

  /**
   * `skipAuth` is not an optimisation — it breaks a cycle.
   *
   * The session routes are how a token is obtained, so asking the session store
   * for one before calling them re-enters the store, which calls them again. The
   * three auth routes are unauthenticated at the gateway for the same reason
   * they are unauthenticated here.
   */
  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    skipAuth = false,
  ): Promise<T> {
    const send = async (token: string | undefined): Promise<Response> =>
      doFetch(`${baseUrl}${path}`, {
        method,
        headers: {
          accept: "application/json",
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    let response: Response;
    try {
      response = await send(skipAuth ? undefined : await getToken());

      // One retry, and only on a 401. The token is renewed a minute before it
      // expires, so reaching here means it was revoked or the clock drifted —
      // both of which a fresh token fixes. Retrying more than once would turn a
      // genuinely signed-out visitor into a loop.
      if (response.status === 401 && !skipAuth) {
        const renewed = await getToken(true);
        if (renewed !== undefined) response = await send(renewed);
      }
    } catch (cause) {
      // fetch rejects only when the request never completed — offline, DNS,
      // TLS, or a CORS preflight the browser refused. An HTTP error status
      // resolves normally and is handled below.
      throw new ApiError({
        status: 0,
        code: "NETWORK_ERROR",
        message:
          cause instanceof Error
            ? `Could not reach the API: ${cause.message}`
            : "Could not reach the API",
      });
    }

    // 204 is the documented success for both deletes, and has no body to parse.
    if (response.status === 204) return undefined as T;

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text === "" ? undefined : JSON.parse(text);
    } catch {
      throw response.ok
        ? new ApiError({
            status: response.status,
            code: "MALFORMED_RESPONSE",
            message: "The API returned a body that is not JSON",
          })
        : toApiError(response.status, undefined);
    }

    if (!response.ok) throw toApiError(response.status, parsed);
    return parsed as T;
  }

  const hostsPath = (targetId: string) => `/targets/${segment(targetId)}/hosts`;

  const rulesPath = (targetId: string, host: string) =>
    `${hostsPath(targetId)}/${segment(host)}/rules`;

  return {
    /** The configured base URL, after trimming. Useful in diagnostics. */
    baseUrl,

    /** Liveness check — `{ status: "ok" }`. */
    health: () => request<{ status: "ok" }>("GET", "/health"),

    /**
     * The session routes. Unauthenticated by necessity — they are what issues a
     * token — and none of them carries the refresh token: it travels as an
     * HttpOnly cookie the browser attaches on its own, which is why these calls
     * take no credential argument.
     */
    auth: {
      /** Completes a hosted-UI login. Sets the refresh cookie as a side effect. */
      session: (input: {
        code: string;
        redirectUri: string;
        codeVerifier?: string;
      }) => request<Session>("POST", "/auth/session", input, true),
      /**
       * A new access token from the cookie, and how the console answers "am I
       * signed in?" on load. Rejects with 401 for a signed-out visitor, which is
       * an ordinary answer rather than a failure.
       */
      refresh: () => request<Session>("POST", "/auth/refresh", undefined, true),
      /** Clears the cookie and returns where to go to end the provider's session too. */
      logout: (returnTo: string) =>
        request<{ logoutUrl: string }>(
          "POST",
          "/auth/logout",
          { returnTo },
          true,
        ),
    },

    targets: {
      list: () => request<Target[]>("GET", "/targets"),
      create: (input: TargetInput) =>
        request<Target>("POST", "/targets", input),
      get: (id: string) => request<Target>("GET", `/targets/${segment(id)}`),
      update: (id: string, input: TargetUpdate) =>
        request<Target>("PUT", `/targets/${segment(id)}`, input),
      remove: (id: string) =>
        request<void>("DELETE", `/targets/${segment(id)}`),
    },

    hosts: {
      /**
       * The target's hosts, sorted by name. A host exists as long as it holds at
       * least one rule, or was created empty — an unknown *target* is a 404, but
       * a target with nothing in it is `[]`.
       */
      list: (targetId: string) =>
        request<HostSummary[]>("GET", hostsPath(targetId)),

      /**
       * Creates a host that has no rules yet, so it survives a reload. A host
       * that already exists — with rules or without — is a 409 `HOST_EXISTS`.
       * The server lowercases it, so the returned `host` is the one to address.
       */
      create: (targetId: string, host: string) =>
        request<HostSummary>("POST", hostsPath(targetId), { host }),

      /**
       * Deletes the host **and every rule under it**. A host that is not there
       * is a 404. Not atomic server-side: a failure part-way leaves the host
       * with fewer rules, and repeating the call finishes the job.
       */
      remove: (targetId: string, host: string) =>
        request<void>("DELETE", `${hostsPath(targetId)}/${segment(host)}`),
    },

    rules: {
      /** A host's rules in edge-evaluation order. An unknown host is `[]`, not a 404. */
      list: (targetId: string, host: string) =>
        request<Rule[]>("GET", rulesPath(targetId, host)),

      create: (targetId: string, host: string, input: RuleInput) =>
        request<Rule>("POST", rulesPath(targetId, host), input),

      get: (targetId: string, host: string, sk: string) =>
        request<Rule>("GET", `${rulesPath(targetId, host)}/${segment(sk)}`),

      /**
       * Full replace. Every field the body omits is cleared, and `priority` is
       * required even when it is not changing — sending a different one moves
       * the rule, which is why `sk` in the path must stay the rule's current key.
       */
      put: (targetId: string, host: string, sk: string, input: RuleInput) =>
        request<Rule>(
          "PUT",
          `${rulesPath(targetId, host)}/${segment(sk)}`,
          input,
        ),

      /** Enable or disable in place. The only field this route accepts. */
      toggle: (targetId: string, host: string, sk: string, disabled: boolean) =>
        request<Rule>("PATCH", `${rulesPath(targetId, host)}/${segment(sk)}`, {
          disabled,
        }),

      remove: (targetId: string, host: string, sk: string) =>
        request<void>("DELETE", `${rulesPath(targetId, host)}/${segment(sk)}`),
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

/**
 * How the shared instance gets a token.
 *
 * Set once by `AuthProvider`, because the two need each other: the session store
 * calls `api.auth.refresh()`, and every other call needs the token that store
 * holds. Injecting it afterwards breaks the cycle without making every consumer
 * of `api` — the stores, the hooks — take a client as an argument.
 *
 * Undefined until then, which is correct rather than merely convenient: before
 * the provider mounts there is no session, and the bootstrap refresh is itself
 * an unauthenticated call.
 */
let authTokenProvider: (force?: boolean) => Promise<string | undefined> = () =>
  Promise.resolve(undefined);

export const setAuthTokenProvider = (
  provider: (force?: boolean) => Promise<string | undefined>,
): void => {
  authTokenProvider = provider;
};

/** The shared instance. Prefer this; build your own only to point elsewhere. */
export const api = createApiClient({
  getToken: (force) => authTokenProvider(force),
});
