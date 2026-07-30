import type { ApiRequest, ApiResponse } from "../context.js";
import { ApiError } from "../lib/errors.js";
import { validateRule } from "../lib/validate.js";
import { resolveTarget } from "../lib/targets-repository.js";

// Rule persistence is ER-203. These stubs enforce the two things that are the
// scaffold's job — the target scope and the request shape — and 501 where a real
// read or write would happen. Resolving the target first makes an unknown
// targetId a 404 rather than indistinguishable from a valid one, and keeps the
// scoping boundary in one place for ER-205 to attach authorization to.
const notImplemented = (operation: string): never => {
  throw new ApiError(
    501,
    "NOT_IMPLEMENTED",
    `${operation} is not implemented yet (ER-203)`,
  );
};

export const listRules = async (req: ApiRequest): Promise<ApiResponse> => {
  await resolveTarget(req.params.targetId);
  return notImplemented("listRules");
};

export const getRule = async (req: ApiRequest): Promise<ApiResponse> => {
  await resolveTarget(req.params.targetId);
  return notImplemented("getRule");
};

export const deleteRule = async (req: ApiRequest): Promise<ApiResponse> => {
  await resolveTarget(req.params.targetId);
  return notImplemented("deleteRule");
};

export const createRule = async (req: ApiRequest): Promise<ApiResponse> => {
  await resolveTarget(req.params.targetId);
  validateRule(req.body);
  return notImplemented("createRule");
};

export const putRule = async (req: ApiRequest): Promise<ApiResponse> => {
  await resolveTarget(req.params.targetId);
  validateRule(req.body);
  return notImplemented("putRule");
};
