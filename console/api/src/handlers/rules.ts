import type { ApiRequest, ApiResponse } from "../context.js";
import { ApiError } from "../lib/errors.js";
import { json } from "../lib/respond.js";
import { parseSk } from "../lib/rule-keys.js";
import { composeRule } from "../lib/rule-input.js";
import { getRulesRepository, type RuleItem } from "../lib/rules-repository.js";
import { resolveTarget } from "../lib/targets-repository.js";

const ruleNotFound = (host: string, sk: string): ApiError =>
  ApiError.notFound(`No rule "${sk}" for host "${host}" in this target`);

/**
 * Priority is unique per host per type because it *is* the sort key. ER-204 owns
 * the friendly form of this; what matters here is that the write was refused
 * rather than silently overwriting the rule already at that priority.
 */
const ruleExists = (item: RuleItem): ApiError =>
  new ApiError(
    409,
    "RULE_EXISTS",
    `Host "${item.pk}" already has a rule at "${item.sk}" — priorities are unique per host and rule type`,
  );

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
  const target = await resolveTarget(req.params.targetId);
  const item = composeRule(req);

  if (!(await getRulesRepository(target).create(item))) throw ruleExists(item);
  return json(201, item);
};

/**
 * Full replace. The path names the rule being addressed and `priority` names
 * where it should end up, so a PUT that changes the priority is a *move*: the
 * item's key changes, and with it the URL the rule answers on — which is why the
 * response body is the authority on where it now lives.
 */
export const putRule = async (req: ApiRequest): Promise<ApiResponse> => {
  const target = await resolveTarget(req.params.targetId);
  const { host, sk } = req.params;
  parseSk(sk);

  const item = composeRule(req);
  const repo = getRulesRepository(target);

  if (item.sk === sk) {
    if (!(await repo.replace(item))) throw ruleNotFound(host, sk);
    return json(200, item);
  }

  const outcome = await repo.move(sk, item);
  if (outcome === "missing") throw ruleNotFound(host, sk);
  if (outcome === "occupied") throw ruleExists(item);
  return json(200, item);
};
