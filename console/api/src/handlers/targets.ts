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
import {
  distributionIdOf,
  getGeoReadinessChecker,
} from "../lib/geo-readiness.js";
import {
  geoDecision,
  type MatchLike,
  type RuleKind,
} from "../lib/geo-relevance.js";

const notFound = (id: string): ApiError =>
  ApiError.notFound(`No target with id "${id}"`);

interface TableIdentity {
  region: string;
  tableName: string;
  roleArn?: string;
}

/** True when an update points the entry at a table other than the one it had. */
const retargets = (current: TableIdentity, input: TableIdentity): boolean =>
  current.region !== input.region ||
  current.tableName !== input.tableName ||
  // A different role can see a different table of the same name, so this is part
  // of *which* table the entry points at, not just how it is reached.
  current.roleArn !== input.roleArn;

/**
 * What a name says about which distribution it is: the ID, whether the name is
 * the ID or its ARN, and the name itself (without case) when it is neither.
 */
const nameIdentity = (name: string): string =>
  distributionIdOf(name) ?? name.trim().toUpperCase();

/**
 * A target is one linked distribution, named after its distribution ID, and the
 * console lists the registry as the team's distributions (CF-56). Two entries
 * for one distribution would be two rows for it, so that is what must be unique
 * — an ID and its ARN name the same one.
 *
 * The table is not: two distributions served by one rules table are two targets
 * pointing at the same data, which the rules routes handle like any other.
 *
 * Read-then-write, so two simultaneous creates can still both succeed. The read
 * is a Scan and therefore eventually consistent, so a genuine double-submit
 * arriving within milliseconds may slip through; this catches the retried submit,
 * not a race. A conditional write on a second uniqueness item would be needed to
 * make it atomic.
 */
const assertNameNotTaken = async (
  name: string,
  exceptId?: string,
): Promise<void> => {
  const existing = await getTargetsRepository().list();
  const clash = existing.find(
    (t) => t.id !== exceptId && nameIdentity(t.name) === nameIdentity(name),
  );

  if (clash) {
    throw new ApiError(
      409,
      "TARGET_EXISTS",
      `"${clash.name}" is already linked`,
    );
  }
};

/**
 * Existence before uniqueness: "there is no such table" is a fact about the
 * input alone, and the more useful of the two answers when the name is also
 * taken. Costs one DescribeTable on the duplicate path.
 */
export const createTarget = async (req: ApiRequest): Promise<ApiResponse> => {
  const input = validateTarget(req.body);
  await getTableVerifier()(input);
  await assertNameNotTaken(input.name);

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
 * Whether the target's distribution can serve the rule being written — what the
 * editor warns about, and the same decision the write guard applies. Always 200
 * for a known target: a distribution the API cannot read is `status: "unknown"`
 * with the cause, not an error, so the editor can say so beside the rule.
 */
export const checkGeoForRule = async (
  req: ApiRequest,
): Promise<ApiResponse> => {
  const { id } = req.params;
  const target = await getTargetsRepository().get(id);
  if (!target) throw notFound(id);

  const { kind, matches } = parseGeoCheck(req.body);
  const readiness = await getGeoReadinessChecker()(
    {
      name: target.name,
      ...(target.roleArn ? { roleArn: target.roleArn } : {}),
      ...(target.edgeFunctionArn
        ? { edgeFunctionArn: target.edgeFunctionArn }
        : {}),
    },
    { fresh: req.query["fresh"] === "true" },
  );
  return json(200, {
    readiness,
    decision: geoDecision(kind, matches, readiness),
  });
};

const isMatch = (value: unknown): value is MatchLike => {
  if (typeof value !== "object" || value === null) return false;
  const match = value as Record<string, unknown>;
  return (
    typeof match["matchType"] === "string" &&
    typeof match["matchOperator"] === "string" &&
    typeof match["matchValue"] === "string"
  );
};

/** `{ kind, matches }` — only what the decision reads, not a whole rule. */
const parseGeoCheck = (
  body: unknown,
): { kind: RuleKind; matches: MatchLike[] } => {
  const { kind, matches } = (body ?? {}) as Record<string, unknown>;
  if (
    (kind !== "redirect" && kind !== "rewrite") ||
    !Array.isArray(matches) ||
    !matches.every(isMatch)
  ) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      'Geo check body must be { kind: "redirect" | "rewrite", matches: [...] }',
    );
  }
  return { kind, matches };
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
  const current = await repo.get(id);
  if (!current) throw notFound(id);

  // An update can retarget an entry at a different table, so it can introduce
  // the same typo a create can. One that leaves the table alone must not be
  // checked: a rename is how an operator labels a target whose table has since
  // been deleted, and re-verifying would refuse the edit and leave them with an
  // entry they can only delete.
  if (retargets(current, input)) await getTableVerifier()(input);
  await assertNameNotTaken(input.name, id);

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
