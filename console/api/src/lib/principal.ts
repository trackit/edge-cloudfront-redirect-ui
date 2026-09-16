import { bearerToken, decodeJwtPayload } from "./jwt-claims.js";

/**
 * Who is making the request. The gateway's JWT authorizer has already checked
 * signature, issuer, audience and expiry, so nothing here validates a token —
 * it only reads group membership off one.
 */
export interface Principal {
  /** The pool's stable user id. Not the email, which a user can change. */
  sub: string;
  email?: string;
  /** `cognito:groups`, verbatim. Empty when the user is in no group. */
  groups: string[];
}

/** Anything outside these two is not a role. */
export type Role = "viewer" | "editor";

const ROLE_GROUPS: Role[] = ["editor", "viewer"];

/**
 * `cognito:groups` is an array in a decoded token but a flattened string in the
 * authorizer context, so the same claim arrives as `["editor"]` or
 * `"[editor viewer]"` depending on its path. Both are read here.
 */
export const parseGroups = (claim: unknown): string[] => {
  if (Array.isArray(claim)) return claim.map(String).filter((g) => g !== "");
  if (typeof claim !== "string") return [];

  return claim
    .replace(/^\[|\]$/g, "")
    .split(/[\s,]+/)
    .filter((group) => group !== "");
};

/**
 * The strongest role the principal holds, or `undefined` for none — a user in no
 * group is refused rather than falling back to read-only. This API can repoint
 * production traffic, so "created but not yet assigned a role" must not grant a
 * view of every target and rule.
 */
export const roleOf = (principal: Principal): Role | undefined =>
  ROLE_GROUPS.find((role) => principal.groups.includes(role));

export const canWrite = (principal: Principal): boolean =>
  roleOf(principal) === "editor";

/**
 * The caller, from the gateway's authorizer context and the token behind it.
 *
 * `claims` being present is what says the gateway ran, so it alone decides
 * whether there is a principal. The token is read for shape, not authority — it
 * carries `cognito:groups` as a real array — and only when its `sub` matches the
 * context's. If the two disagree this falls back to the verified context rather
 * than believing the header.
 */
export const principalFrom = (
  claims: Record<string, unknown> | undefined,
  authorization: string | undefined,
): Principal | undefined => {
  if (claims === undefined) return undefined;

  const sub = claims.sub;
  // Not a token Cognito issues. "No principal" makes the router refuse the
  // request rather than invent an identity with no id.
  if (typeof sub !== "string" || sub === "") return undefined;

  const payload = decodeJwtPayload(bearerToken(authorization));
  const fromToken = payload?.sub === sub ? payload : undefined;
  const email = fromToken?.email ?? claims.email;

  return {
    sub,
    ...(typeof email === "string" ? { email } : {}),
    groups: parseGroups(
      fromToken === undefined
        ? claims["cognito:groups"]
        : fromToken["cognito:groups"],
    ),
  };
};
