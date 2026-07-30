import { randomUUID } from "node:crypto";
import type { ApiRequest, ApiResponse } from "../context.js";
import { ApiError } from "../lib/errors.js";
import { json } from "../lib/respond.js";
import { validateTarget } from "../lib/validate-target.js";
import {
  getTargetsRepository,
  type Target,
} from "../lib/targets-repository.js";

const notFound = (id: string): ApiError =>
  ApiError.notFound(`No target with id "${id}"`);

/**
 * Registering the same table twice produces entries the UI cannot tell apart
 * while both write to the same data.
 *
 * `roleArn` is part of the identity, not just the region and table name: a table
 * name is only unique *within an account*, so two accounts following the same
 * naming convention legitimately both have `edgeroute-rules` in `us-east-1`.
 * Keying on (region, tableName) alone would reject the second one — the very
 * case the per-target role exists to support.
 *
 * Read-then-write, so two simultaneous creates can still both succeed. Note the
 * read is a Scan and therefore eventually consistent, so a genuine double-submit
 * arriving within milliseconds may slip through; this catches the retried submit,
 * not a race. A conditional write on a second uniqueness item would be needed to
 * make it atomic.
 */
const identityOf = (target: {
  region: string;
  tableName: string;
  roleArn?: string;
}): string => `${target.roleArn ?? ""} ${target.region} ${target.tableName}`;

const assertTableNotRegistered = async (
  input: { region: string; tableName: string; roleArn?: string },
  exceptId?: string,
): Promise<void> => {
  const wanted = identityOf(input);
  const existing = await getTargetsRepository().list();
  const clash = existing.find(
    (t) => t.id !== exceptId && identityOf(t) === wanted,
  );

  if (clash) {
    const where = input.roleArn ? ` via ${input.roleArn}` : "";
    throw new ApiError(
      409,
      "TARGET_EXISTS",
      `Table "${input.tableName}" in ${input.region}${where} is already registered as target "${clash.id}"`,
    );
  }
};

export const createTarget = async (req: ApiRequest): Promise<ApiResponse> => {
  const input = validateTarget(req.body);
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

export const updateTarget = async (req: ApiRequest): Promise<ApiResponse> => {
  const { id } = req.params;
  const input = validateTarget(req.body);
  const repo = getTargetsRepository();
  if (!(await repo.get(id))) throw notFound(id);
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
