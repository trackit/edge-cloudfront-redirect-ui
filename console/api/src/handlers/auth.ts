import type { ApiRequest, ApiResponse } from "../context.js";
import { getAuthConfig } from "../config.js";
import {
  clearedRefreshCookie,
  readRefreshCookie,
  refreshCookie,
} from "../lib/auth-cookie.js";
import { exchangeCode, logoutUrl, refreshTokens } from "../lib/cognito.js";
import type { CognitoConfig, TokenSet } from "../lib/cognito.js";
import { ApiError } from "../lib/errors.js";
import { json } from "../lib/respond.js";

/**
 * The half of the login the browser cannot do for itself.
 *
 * These three routes are the reason the console holds no long-lived credential:
 * the code exchange needs the client secret, and the refresh token that comes
 * back goes into an HttpOnly cookie rather than to script. What the SPA receives
 * is an access token with an hour on it and nothing that can outlive the tab.
 *
 * They are unauthenticated because they are what issues the token — requiring
 * one would be circular. That does not make them open: the exchange needs a code
 * only Cognito issues after a real login, and the refresh needs a cookie only
 * this API can have set.
 */

/** Thirty days, matching `refresh_token_validity` on the app client. */
const REFRESH_MAX_AGE = 30 * 24 * 60 * 60;

/**
 * `Secure` is dropped only for plain-http localhost. A browser silently discards
 * a `Secure` cookie sent over http, which presents as a login that appears to
 * work and then forgets you on the next request — so the exception exists to
 * make local dev possible, and is keyed on the request rather than on a flag
 * someone could leave set in a deployment.
 */
const isInsecureLocalhost = (req: ApiRequest): boolean => {
  const host = req.headers.host ?? "";
  const proto = req.headers["x-forwarded-proto"];
  return (
    (host.startsWith("localhost:") || host.startsWith("127.0.0.1:")) &&
    proto !== "https"
  );
};

const cognitoConfig = (): CognitoConfig => {
  const { clientId, clientSecret, domain } = getAuthConfig();
  return { clientId, clientSecret, domain };
};

const stringField = (body: unknown, field: string): string | undefined => {
  if (typeof body !== "object" || body === null) return undefined;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === "string" && value !== "" ? value : undefined;
};

/**
 * What the SPA gets back. The refresh token is deliberately absent — it went
 * into the cookie, and putting it here as well would undo the point of the
 * cookie being HttpOnly.
 */
const session = (tokens: TokenSet): Record<string, unknown> => ({
  accessToken: tokens.accessToken,
  idToken: tokens.idToken,
  expiresIn: tokens.expiresIn,
});

/**
 * POST /auth/session — trade the authorization code for a session.
 *
 * The redirect URI comes from the caller because the console runs at more than
 * one origin (a developer's localhost, the deployed distribution) and the code
 * was issued against whichever one started the login. Cognito rejects a value
 * that is not on the app client's callback list, so this is not a redirect an
 * attacker can choose — the allowlist lives in Terraform.
 */
export const createSession = async (req: ApiRequest): Promise<ApiResponse> => {
  const code = stringField(req.body, "code");
  const redirectUri = stringField(req.body, "redirectUri");

  if (code === undefined || redirectUri === undefined) {
    throw new ApiError(400, "BAD_REQUEST", "code and redirectUri are required");
  }

  const tokens = await exchangeCode(cognitoConfig(), {
    code,
    redirectUri,
    ...(stringField(req.body, "codeVerifier") === undefined
      ? {}
      : { codeVerifier: stringField(req.body, "codeVerifier") as string }),
  });

  if (tokens.refreshToken === undefined) {
    // Cognito always returns one for this grant; if it did not, the session
    // would work until the first refresh and then log the user out for no
    // visible reason. Better to fail now, where the cause is legible.
    throw new ApiError(
      502,
      "INTERNAL",
      "The identity provider issued no refresh token",
    );
  }

  return {
    ...json(200, session(tokens)),
    cookies: [
      refreshCookie(tokens.refreshToken, {
        maxAge: REFRESH_MAX_AGE,
        secure: !isInsecureLocalhost(req),
      }),
    ],
  };
};

/**
 * POST /auth/refresh — a new access token from the cookie.
 *
 * Also how the console answers "am I signed in?" on load: nothing is kept in
 * storage, so the only way to know is to ask. A 401 here is the ordinary answer
 * for a signed-out visitor, not an error.
 */
export const refreshSession = async (req: ApiRequest): Promise<ApiResponse> => {
  const refreshToken = readRefreshCookie(req.headers.cookie);
  if (refreshToken === "") {
    throw ApiError.unauthorized("Not signed in");
  }

  let tokens: TokenSet;
  try {
    tokens = await refreshTokens(cognitoConfig(), refreshToken);
  } catch (caught) {
    // A rejected refresh token will never work again — revoked, expired, or
    // from a pool that has been replaced. Clearing it stops the console
    // retrying with it on every load.
    if (caught instanceof ApiError && caught.status === 401) {
      return {
        ...json(401, {
          error: { code: "UNAUTHORIZED", message: "Your session has ended" },
        }),
        cookies: [clearedRefreshCookie(!isInsecureLocalhost(req))],
      };
    }
    throw caught;
  }

  return json(200, session(tokens));
};

/**
 * POST /auth/logout — end the session here, and say where to go to end it there.
 *
 * Two halves, and the second is not optional: Cognito keeps its own session
 * cookie, so clearing ours alone means the next sign-in walks straight back in
 * without a prompt. The console sends the browser to the returned URL.
 */
export const endSession = (req: ApiRequest): ApiResponse => {
  const returnTo = stringField(req.body, "returnTo");
  if (returnTo === undefined) {
    throw new ApiError(400, "BAD_REQUEST", "returnTo is required");
  }

  return {
    ...json(200, { logoutUrl: logoutUrl(cognitoConfig(), returnTo) }),
    cookies: [clearedRefreshCookie(!isInsecureLocalhost(req))],
  };
};
