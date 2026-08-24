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
