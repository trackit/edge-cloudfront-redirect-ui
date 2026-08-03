import type { ApiRequest, ApiResponse } from "../context.js";
import { ApiError } from "../lib/errors.js";
import { validateRule } from "../lib/validate.js";
import { resolveTarget } from "../lib/targets-repository.js";

// Rule persistence is ER-203. These stubs enforce the three things that are the
// scaffold's job — the target scope, the request shape, and that the body
// addresses the same rule as the path — and 501 where a real read or write would
// happen. Resolving the target first makes an unknown targetId a 404 rather than
// indistinguishable from a valid one, and keeps the scoping boundary in one place
// for ER-205 to attach authorization to.
const notImplemented = (operation: string): never => {
  throw new ApiError(
    501,
    "NOT_IMPLEMENTED",
    `${operation} is not implemented yet (ER-203)`,
  );
};

/**
 * A rule item carries its own keys: `pk` is the host, `sk` is TYPE#priority. The
 * path says the same thing, so the two can disagree — and ER-203 will write
 * `Item: body`, which would put the item in a partition the caller never
 * addressed. `PUT` is worse: a mismatched `sk` creates a second item instead of
 * replacing the addressed one.
 *
 * Checked here so it sits at the same choke point as the target scope, while the
 * routes are still stubs. Path params arrive URL-decoded, so `sk` compares
 * against `REDIRECT#00100`, not `REDIRECT%2300100`.
 */
const assertBodyMatchesPath = (req: ApiRequest): void => {
  const body = req.body as { pk?: unknown; sk?: unknown };
  const mismatched: { path: string; message: string }[] = [];

  if (body.pk !== req.params.host) {
    mismatched.push({
      path: "/pk",
      message: `must equal the host in the path ("${req.params.host}")`,
    });
  }

  // Only the item routes address a specific sort key; the collection routes have
  // nothing to compare against.
  if (req.params.sk !== undefined && body.sk !== req.params.sk) {
    mismatched.push({
      path: "/sk",
      message: `must equal the sort key in the path ("${req.params.sk}")`,
    });
  }

  if (mismatched.length > 0) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Rule body does not match the path it was sent to",
      mismatched,
    );
  }
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
  assertBodyMatchesPath(req);
  return notImplemented("createRule");
};

export const putRule = async (req: ApiRequest): Promise<ApiResponse> => {
  await resolveTarget(req.params.targetId);
  validateRule(req.body);
  assertBodyMatchesPath(req);
  return notImplemented("putRule");
};
