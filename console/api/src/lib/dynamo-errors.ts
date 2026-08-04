import { ApiError } from "./errors.js";
import type { ResolvedTarget } from "./targets-repository.js";

/**
 * Failures that mean "this target's table cannot be reached", as opposed to
 * "the request was wrong". Targets are registered at runtime while IAM is
 * granted at apply time (see console/api/infra/README.md), so the common case is
 * a perfectly valid registry entry the API has no path to: `target_table_arns`
 * and `assumable_role_arns` are both empty by default. Without this mapping that
 * arrives as an opaque 500 and the operator has nothing to go on.
 *
 * Matched by `name` — the SDK's own error classes are not importable for STS and
 * DynamoDB alike without pulling in both clients' error types.
 */
const UNREACHABLE = new Set([
  // The role's trust policy refuses this Lambda, or the assumed role is not
  // allowed the DynamoDB action.
  "AccessDenied",
  "AccessDeniedException",
  // The role could not be assumed at all — bad ARN, or sts:AssumeRole missing
  // from the execution role.
  "CredentialsProviderError",
  "ExpiredTokenException",
  "InvalidSignatureException",
  "UnrecognizedClientException",
  // The registry points at a table that does not exist in that region.
  "ResourceNotFoundException",
]);

const nameOf = (err: unknown): string =>
  typeof err === "object" && err !== null && "name" in err
    ? String((err as { name: unknown }).name)
    : "";

/** True for the conditional write that failed its `attribute_exists` guard. */
export const isConditionalCheckFailed = (err: unknown): boolean =>
  nameOf(err) === "ConditionalCheckFailedException";

/**
 * True when DynamoDB says the table itself is not there. Distinct from the
 * `UNREACHABLE` set above, which lumps it in with "cannot reach": at
 * registration this one is a definitive answer about the *input* and the others
 * are not, so `verify-table.ts` has to tell them apart.
 */
export const isResourceNotFound = (err: unknown): boolean =>
  nameOf(err) === "ResourceNotFoundException";

/**
 * Maps a DynamoDB/STS failure to the error a client should see: a 502 naming the
 * unreachable table, or the original error (which becomes a 500) for anything
 * else — a malformed request the API built itself is a bug here, not a caller's
 * problem to interpret.
 */
export const toTargetError = (
  err: unknown,
  target: ResolvedTarget,
): unknown => {
  if (!UNREACHABLE.has(nameOf(err))) return err;

  const via = target.roleArn
    ? `assuming ${target.roleArn}`
    : "the API's own execution role";

  return new ApiError(
    502,
    "TARGET_UNREACHABLE",
    `Cannot reach table "${target.tableName}" in ${target.region} ${via}: ${nameOf(err)}. The target is registered but the API has no access to it — check the role's trust and permissions policies, or the table's IAM grant.`,
  );
};
