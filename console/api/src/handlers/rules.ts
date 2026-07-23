import type { ApiRequest, ApiResponse } from "../context.js";
import { ApiError } from "../lib/errors.js";
import { validateRule } from "../lib/validate.js";

// Persistence (the DynamoDB targets registry + rule CRUD) is ER-203. These
// stubs wire routing and request validation now; each 501s where a real read or
// write would happen.
const notImplemented = (operation: string): never => {
  throw new ApiError(
    501,
    "NOT_IMPLEMENTED",
    `${operation} is not implemented yet (ER-203)`,
  );
};

export const listRules = (): ApiResponse => notImplemented("listRules");

export const getRule = (): ApiResponse => notImplemented("getRule");

export const deleteRule = (): ApiResponse => notImplemented("deleteRule");

export const createRule = (req: ApiRequest): ApiResponse => {
  validateRule(req.body);
  return notImplemented("createRule");
};

export const putRule = (req: ApiRequest): ApiResponse => {
  validateRule(req.body);
  return notImplemented("putRule");
};
