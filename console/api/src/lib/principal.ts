import { bearerToken, decodeJwtPayload } from "./jwt-claims.js";

/**
 * Who is making the request, as the API cares about it.
 *
 * The gateway's JWT authorizer has already checked the signature, issuer,
 * audience and expiry by the time these claims arrive, so nothing here validates
 * the token — it only reads it. What is left to decide is what the caller is
 * allowed to do, which is a question about group membership rather than about
 * cryptography.
 */
export interface Principal {
  /** The pool's stable user id. Not the email, which a user can change. */
  sub: string;
  email?: string;
  /** `cognito:groups`, verbatim. Empty when the user is in no group. */
  groups: string[];
}

/** The role a principal holds. Anything outside these two is not a role. */
export type Role = "viewer" | "editor";

const ROLE_GROUPS: Role[] = ["editor", "viewer"];

/**
 * `cognito:groups` arrives as an array in a decoded token, but API Gateway
 * flattens claim values into strings before handing them to the Lambda, so the
 * same claim can be `["editor"]` or `"[editor viewer]"` depending on the path
 * it took. Both spellings are read here rather than in the caller.
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
 * The strongest role the principal holds, or `undefined` for none.
 *
 * A user in no group has no role and is refused, rather than falling back to
 * read-only. Failing closed matters more than convenience here: this API can
 * repoint production traffic, and "created but not yet assigned a role" should
 * not be a state that grants a view of every target and rule.
 */
export const roleOf = (principal: Principal): Role | undefined =>
  ROLE_GROUPS.find((role) => principal.groups.includes(role));

/** Whether this principal may perform a write. */
export const canWrite = (principal: Principal): boolean =>
  roleOf(principal) === "editor";

/**
 * The caller, from the gateway's authorizer context and the token behind it.
 *
 * `claims` being present is what says the gateway ran, so it is the only thing
 * that decides whether there is a principal at all. `authorization` is read for
 * shape, not for authority: the token carries `cognito:groups` as a real array,
 * where the authorizer context carries a flattened string we would otherwise be
 * parsing by guesswork.
 *
 * Identity still comes from the verified context. The token's groups are used
 * only when its `sub` matches the context's — if the two disagree, something has
 * gone wrong upstream that this function is in no position to adjudicate, so it
 * falls back to the context alone rather than believing the header.
 */
export const principalFrom = (
  claims: Record<string, unknown> | undefined,
  authorization: string | undefined,
): Principal | undefined => {
  if (claims === undefined) return undefined;

  const sub = claims.sub;
  // Not a token Cognito issues. Treating it as "no principal" means the router
  // refuses the request rather than inventing an identity with no id.
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
