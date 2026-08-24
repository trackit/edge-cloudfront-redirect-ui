import { ApiError } from "./errors.js";

/**
 * The pool's token endpoint, and nothing else.
 *
 * This is the half of the login the browser must not do. Exchanging a code needs
 * the client secret, and the refresh token that comes back has to be put into an
 * HttpOnly cookie rather than handed to script — so both calls happen here, and
 * the SPA only ever sees a short-lived access token.
 */
export interface CognitoConfig {
  /** e.g. https://edgeroute.auth.us-east-1.amazoncognito.com */
  domain: string;
  clientId: string;
  clientSecret: string;
}

export interface TokenSet {
  accessToken: string;
  idToken: string;
  /** Absent on a refresh: Cognito reissues an access token, not the refresh one. */
  refreshToken?: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
}

/** Injected so the tests do not reach the network. */
export type FetchLike = typeof globalThis.fetch;

let fetchImpl: FetchLike | undefined;

export const setCognitoFetch = (impl: FetchLike): void => {
  fetchImpl = impl;
};

export const resetCognitoFetch = (): void => {
  fetchImpl = undefined;
};

const doFetch: FetchLike = (...args) =>
  (fetchImpl ?? globalThis.fetch)(...args);

interface TokenResponse {
  access_token?: string;
  id_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
}

/**
 * Cognito authenticates the client with HTTP Basic on the token endpoint, which
 * is why the secret exists at all: it proves the exchange is coming from the API
 * and not from anyone who intercepted the code.
 */
const basicAuth = (config: CognitoConfig): string =>
  `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`;

const post = async (
  config: CognitoConfig,
  form: Record<string, string>,
): Promise<TokenSet> => {
  let response: Response;
  try {
    response = await doFetch(`${config.domain}/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: basicAuth(config),
      },
      body: new URLSearchParams(form).toString(),
    });
  } catch (cause) {
    // The pool being unreachable is our problem, not the caller's, so this is a
    // 502 rather than a 401 that would send them round the login loop again.
    throw new ApiError(
      502,
      "INTERNAL",
      `Could not reach the identity provider: ${cause instanceof Error ? cause.message : "unknown error"}`,
    );
  }

  const payload = (await response.json().catch(() => ({}))) as TokenResponse;

  if (!response.ok) {
    // Deliberately not forwarded verbatim. Cognito distinguishes an expired code
    // from an unknown one, and repeating that back tells an attacker which of
    // their guesses was shaped correctly.
    throw ApiError.unauthorized("That sign-in could not be completed");
  }

  if (
    typeof payload.access_token !== "string" ||
    typeof payload.id_token !== "string" ||
    typeof payload.expires_in !== "number"
  ) {
    throw new ApiError(
      502,
      "INTERNAL",
      "The identity provider returned an unusable token response",
    );
  }

  return {
    accessToken: payload.access_token,
    idToken: payload.id_token,
    ...(typeof payload.refresh_token === "string"
      ? { refreshToken: payload.refresh_token }
      : {}),
    expiresIn: payload.expires_in,
  };
};

/**
 * Trades the authorization code for tokens.
 *
 * `redirect_uri` is sent again even though the code was already issued against
 * it: the endpoint compares the two, which is what stops a code intercepted from
 * one client being redeemed by another.
 */
export const exchangeCode = (
  config: CognitoConfig,
  params: { code: string; redirectUri: string; codeVerifier?: string },
): Promise<TokenSet> =>
  post(config, {
    grant_type: "authorization_code",
    client_id: config.clientId,
    code: params.code,
    redirect_uri: params.redirectUri,
    ...(params.codeVerifier === undefined
      ? {}
      : { code_verifier: params.codeVerifier }),
  });

/** Mints a new access token from the refresh token in the cookie. */
export const refreshTokens = (
  config: CognitoConfig,
  refreshToken: string,
): Promise<TokenSet> =>
  post(config, {
    grant_type: "refresh_token",
    client_id: config.clientId,
    refresh_token: refreshToken,
  });

/**
 * Where the browser has to go to actually be signed out.
 *
 * Clearing our cookie ends the console's session but not Cognito's: its own
 * session cookie survives, so the next "sign in" would walk straight back in
 * with no prompt. That reads as a security bug to anyone who tries it, so the
 * console sends the browser here as the second half of logging out.
 */
export const logoutUrl = (config: CognitoConfig, returnTo: string): string =>
  `${config.domain}/logout?client_id=${encodeURIComponent(config.clientId)}&logout_uri=${encodeURIComponent(returnTo)}`;
