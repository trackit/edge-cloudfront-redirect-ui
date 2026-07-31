import type { ApiRequest, ApiResponse } from "../context.js";
import { ApiError } from "../lib/errors.js";
import { json } from "../lib/respond.js";
import { parseSk } from "../lib/rule-keys.js";
import { getRulesRepository } from "../lib/rules-repository.js";
import { validateRule } from "../lib/validate.js";
import { resolveTarget } from "../lib/targets-repository.js";

// Reading and deleting rules is live; create and update are the second half of
// ER-203 and still 501, so they keep the scaffold's checks — the request shape
// and that the body addresses the same rule as the path.
const notImplemented = (operation: string): never => {
  throw new ApiError(
    501,
    "NOT_IMPLEMENTED",
    `${operation} is not implemented yet (ER-203)`,
  );
};

/**
 * A rule item carries its own keys: `pk` is the host, `sk` is TYPE#priority. The
 * path says the same thing, so the two can disagree — and a write of `Item: body`
 * would put the item in a partition the caller never addressed. `PUT` is worse: a
 * mismatched `sk` creates a second item instead of replacing the addressed one.
 *
 * Path params arrive URL-decoded, so `sk` compares against `REDIRECT#00100`, not
 * `REDIRECT%2300100`.
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

const ruleNotFound = (host: string, sk: string): ApiError =>
  ApiError.notFound(`No rule "${sk}" for host "${host}" in this target`);

export const listRules = async (req: ApiRequest): Promise<ApiResponse> => {
  const target = await resolveTarget(req.params.targetId);
  const rules = await getRulesRepository(target).listByHost(req.params.host);

  // DynamoDB already returns ascending sk, but sorting here keeps the order a
  // documented property of the endpoint rather than an implementation detail of
  // whichever repository answered — the same reason RulesService re-sorts.
  rules.sort((a, b) => a.sk.localeCompare(b.sk));
  return json(200, rules);
};

export const getRule = async (req: ApiRequest): Promise<ApiResponse> => {
  const target = await resolveTarget(req.params.targetId);
  const { host, sk } = req.params;
  parseSk(sk);

  const rule = await getRulesRepository(target).get(host, sk);
  if (!rule) throw ruleNotFound(host, sk);
  return json(200, rule);
};

export const deleteRule = async (req: ApiRequest): Promise<ApiResponse> => {
  const target = await resolveTarget(req.params.targetId);
  const { host, sk } = req.params;
  parseSk(sk);

  const deleted = await getRulesRepository(target).delete(host, sk);
  if (!deleted) throw ruleNotFound(host, sk);
  return json(204, undefined);
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
