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

export const createTarget = async (req: ApiRequest): Promise<ApiResponse> => {
  const input = validateTarget(req.body);
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
