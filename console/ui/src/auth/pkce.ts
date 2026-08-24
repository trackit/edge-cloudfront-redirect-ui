/**
 * Starting a login: where to send the browser, and the proof it comes back with.
 *
 * PKCE is not strictly required here — the code is redeemed by the API using a
 * client secret, which is already proof the exchange is ours. It is done anyway
 * because the code travels through the browser's address bar and its history,
 * and the verifier means a code copied out of either is worthless without the
 * value only this tab holds.
 */

/** Where the login round trip is kept while the browser is away at Cognito. */
const PENDING_KEY = "edgeroute.auth.pending";

export interface PendingLogin {
  /** Proves the code came back to the tab that asked for it. */
  verifier: string;
  /** Echoed by Cognito, checked on return — this is the CSRF guard. */
  state: string;
  /** Where to go once signed in, so a deep link survives the detour. */
  returnTo: string;
}

const randomString = (bytes: number): string => {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return base64Url(buffer);
};

/**
 * Base64url, which is base64 with the two URL-unsafe characters swapped and the
 * padding dropped. A raw base64 verifier would be re-encoded in the query string
 * and no longer match what the API sends on.
 */
export const base64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

/** The S256 challenge derived from a verifier. */
export const challengeFor = async (verifier: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64Url(new Uint8Array(digest));
};

export const newPendingLogin = (returnTo: string): PendingLogin => ({
  // 32 bytes each: comfortably above the 43-character minimum a verifier needs
  // once base64url-encoded.
  verifier: randomString(32),
  state: randomString(16),
  returnTo,
});

/**
 * Held in `sessionStorage`, not memory: the browser leaves for Cognito and comes
 * back as a fresh page load, so anything in a variable is gone by then. Per-tab
 * and cleared on close, which is the right lifetime for something that is only
 * meaningful between leaving and returning.
 */
export const savePendingLogin = (pending: PendingLogin): void => {
  sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
};

/**
 * Reads it back and removes it in one step. A login round trip is single-use, so
 * leaving it behind would let a replayed callback URL be accepted twice.
 */
export const takePendingLogin = (): PendingLogin | undefined => {
  const raw = sessionStorage.getItem(PENDING_KEY);
  sessionStorage.removeItem(PENDING_KEY);
  if (raw === null) return undefined;

  try {
    const parsed = JSON.parse(raw) as Partial<PendingLogin>;
    if (
      typeof parsed.verifier !== "string" ||
      typeof parsed.state !== "string" ||
      typeof parsed.returnTo !== "string"
    ) {
      return undefined;
    }
    return parsed as PendingLogin;
  } catch {
    // Someone else's data under our key, or a half-written value. Treat it as no
    // login in progress rather than throwing on a page the user can see.
    return undefined;
  }
};

export interface AuthorizeParams {
  /** Hosted UI base URL. */
  domain: string;
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
}

/** The hosted UI URL that starts a login. */
export const authorizeUrl = ({
  domain,
  clientId,
  redirectUri,
  state,
  challenge,
}: AuthorizeParams): string => {
  const query = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    scope: "openid email profile",
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${domain}/oauth2/authorize?${query.toString()}`;
};
