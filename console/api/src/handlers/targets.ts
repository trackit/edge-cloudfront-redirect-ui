import { randomUUID } from "node:crypto";
import type { ApiRequest, ApiResponse } from "../context.js";
import { ApiError } from "../lib/errors.js";
import { json } from "../lib/respond.js";
import { validateTarget } from "../lib/validate-target.js";
import {
  getTargetsRepository,
  type Target,
} from "../lib/targets-repository.js";
import { getTableVerifier } from "../lib/verify-table.js";

const notFound = (id: string): ApiError =>
  ApiError.notFound(`No target with id "${id}"`);

interface TableIdentity {
  region: string;
  tableName: string;
  roleArn?: string;
}

/**
 * Sentinel for "the account cannot be determined" — either because the target
 * carries no `roleArn` (the table is then in the API's own account, which we
 * cannot name without an STS call) or because a `roleArn` written to the table
 * out of band does not parse. Both cases clash with every account, so an
 * unknown account fails closed rather than sneaking past as its own namespace.
 */
const UNKNOWN_ACCOUNT = "unknown";

/**
 * Account portion of a role ARN — `arn:aws:iam::<account>:role/<name>`, so the
 * fifth colon-separated field. `validateTarget` has already enforced that shape
 * for anything arriving over the API, so the fallback only guards items written
 * to the table out of band.
 */
const accountOf = (roleArn?: string): string => {
  if (roleArn === undefined) return UNKNOWN_ACCOUNT;
  return roleArn.split(":")[4] || UNKNOWN_ACCOUNT;
};

/**
 * Two registry entries for one table are entries the UI cannot tell apart while
 * both write to the same data. What identifies a table is
 * (account, region, tableName) — **not** the role ARN.
 *
 * The account matters because a table name is only unique within an account, so
 * two accounts following the same naming convention legitimately both have
 * `edgeroute-rules` in `us-east-1`. The role *name* must not matter: two
 * different roles in the same account granting access to the same table are two
 * views of one table, not two targets.
 *
 * An unknown account on either side clashes with everything — see
 * UNKNOWN_ACCOUNT. That fails closed: registering the same table once with and
 * once without a role is caught, at the cost of rejecting the rare "local table
 * plus a same-named table in another account". Setting `roleArn` on both
 * disambiguates them.
 *
 * Caveat: this compares the account of the *role*, as a proxy for the account of
 * the *table*. DynamoDB resource-based policies mean a role in one account can
 * reach a table in another, so two roles in different accounts pointing at one
 * table are not detected. Cross-account is out of scope for now, but this is the
 * limit of what the check can see without describing the table.
 */
const identifiesSameTable = (a: TableIdentity, b: TableIdentity): boolean => {
  if (a.region !== b.region || a.tableName !== b.tableName) return false;

  const accountA = accountOf(a.roleArn);
  const accountB = accountOf(b.roleArn);
  if (accountA === UNKNOWN_ACCOUNT || accountB === UNKNOWN_ACCOUNT) return true;
  return accountA === accountB;
};

/**
 * Read-then-write, so two simultaneous creates can still both succeed. The read
 * is a Scan and therefore eventually consistent, so a genuine double-submit
 * arriving within milliseconds may slip through; this catches the retried submit,
 * not a race. A conditional write on a second uniqueness item would be needed to
 * make it atomic.
 */
const assertTableNotRegistered = async (
  input: TableIdentity,
  exceptId?: string,
): Promise<void> => {
  const existing = await getTargetsRepository().list();
  const clash = existing.find(
    (t) => t.id !== exceptId && identifiesSameTable(t, input),
  );

  if (clash) {
    // Describe the *clashing* entry, not the input — the two can disagree about
    // the account, and naming the input's account here would send an operator
    // looking in an account where nothing is registered. When either side's
    // account is unknown, say so and how to resolve it instead of guessing.
    const clashAccount = accountOf(clash.roleArn);
    const inputAccount = accountOf(input.roleArn);

    const detail =
      clashAccount === UNKNOWN_ACCOUNT || inputAccount === UNKNOWN_ACCOUNT
        ? `target "${clash.id}" already registers table "${clash.tableName}" in ${clash.region}. One of them has no roleArn, so its account cannot be determined and they are assumed to be the same table — set roleArn on both if they are different tables.`
        : `target "${clash.id}" already registers table "${clash.tableName}" in ${clash.region} in account ${clashAccount}.`;

    throw new ApiError(409, "TARGET_EXISTS", detail);
  }
};

/**
 * Existence before uniqueness: "there is no such table" is a fact about the
 * input alone, and it is the more useful of the two answers when a nonexistent
 * table is *also* already registered — which is exactly the state the missing
 * check used to produce. Costs one DescribeTable on the duplicate path.
 */
export const createTarget = async (req: ApiRequest): Promise<ApiResponse> => {
  const input = validateTarget(req.body);
  await getTableVerifier()(input);
  await assertTableNotRegistered(input);

  const target: Target = { id: randomUUID(), ...input };
  await getTargetsRepository().create(target);
  return json(201, target);
};

export const listTargets = async (): Promise<ApiResponse> => {
  const targets = await getTargetsRepository().list();
  targets.sort((a, b) => a.name.localeCompare(b.name));
  return json(200, targets);
};

export const getTarget = async (req: ApiRequest): Promise<ApiResponse> => {
  const { id } = req.params;
  const target = await getTargetsRepository().get(id);
  if (!target) throw notFound(id);
  return json(200, target);
};

/**
 * `TargetInput` forbids `id`, which is right for create — the server assigns it.
 * On update it would force every caller to strip `id` before PUT-ing back what
 * GET just returned, so an `id` matching the path is accepted and dropped, and
 * only a *mismatched* one is an error. The path is the authority either way.
 */
const withoutMatchingId = (body: unknown, id: string): unknown => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return body;
  }
  if (!("id" in body)) return body;

  const { id: bodyId, ...rest } = body as { id: unknown };
  if (bodyId !== id) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Target body does not match the path it was sent to",
      [{ path: "/id", message: `must equal the id in the path ("${id}")` }],
    );
  }
  return rest;
};

export const updateTarget = async (req: ApiRequest): Promise<ApiResponse> => {
  const { id } = req.params;
  const input = validateTarget(withoutMatchingId(req.body, id));
  const repo = getTargetsRepository();
  if (!(await repo.get(id))) throw notFound(id);
  // An update can retarget an entry at a different table, so it can introduce
  // the same typo a create can.
  await getTableVerifier()(input);
  await assertTableNotRegistered(input, id);

  const target: Target = { id, ...input };
  await repo.put(target);
  return json(200, target);
};

export const deleteTarget = async (req: ApiRequest): Promise<ApiResponse> => {
  const { id } = req.params;
  const repo = getTargetsRepository();
  if (!(await repo.get(id))) throw notFound(id);

  // Registry only — the target's actual DynamoDB rules table is never deleted.
  await repo.delete(id);
  return json(204, undefined);
};
