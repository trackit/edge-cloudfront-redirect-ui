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
 * A (region, tableName) pair identifies one rules table, so registering it twice
 * produces entries the UI cannot tell apart while both write to the same data.
 * Read-then-write, so two simultaneous creates can still both succeed — this
 * catches the realistic case (a retried or double-clicked submit), not a race.
 */
const assertTableNotRegistered = async (
  input: { region: string; tableName: string },
  exceptId?: string,
): Promise<void> => {
  const existing = await getTargetsRepository().list();
  const clash = existing.find(
    (t) =>
      t.id !== exceptId &&
      t.region === input.region &&
      t.tableName === input.tableName,
  );

  if (clash) {
    throw new ApiError(
      409,
      "TARGET_EXISTS",
      `Table "${input.tableName}" in ${input.region} is already registered as target "${clash.id}"`,
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
