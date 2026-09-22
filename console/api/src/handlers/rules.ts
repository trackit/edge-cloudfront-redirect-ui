import type { ApiRequest, ApiResponse } from "../context.js";
import { ApiError } from "../lib/errors.js";
import { json } from "../lib/respond.js";
import { KIND_BY_TYPE, parseSk } from "../lib/rule-keys.js";
import { composeRule, parseToggle } from "../lib/rule-input.js";
import { parseReorder, planReorder } from "../lib/rule-order.js";
import { getRulesRepository, type RuleItem } from "../lib/rules-repository.js";
import { resolveTarget } from "../lib/targets-repository.js";

const ruleNotFound = (host: string, sk: string): ApiError =>
  ApiError.notFound(`No rule "${sk}" for host "${host}" in this target`);

/**
 * Priority is unique per host per type because it *is* the sort key. Validation owns
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

/**
 * The enable/disable toggle — the one edit that is not a full replace, because
 * turning a rule off is a single click in the UI and must not depend on the
 * client holding a complete, current copy of the rule.
 *
 * Takes effect at the edge within its cache TTL (~1 min), not instantly.
 */
export const toggleRule = async (req: ApiRequest): Promise<ApiResponse> => {
  const target = await resolveTarget(req.params.targetId);
  const { host, sk } = req.params;
  parseSk(sk);

  const disabled = parseToggle(req.body);
  const rule = await getRulesRepository(target).setDisabled(host, sk, disabled);
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
 * Reorders a host's rules of one kind — the save behind drag & drop (CF-31).
 *
 * One request rather than a PUT per rule: the priorities are the rules' keys, so
 * a reorder is several moves that have to land together. Done one at a time, a
 * failure half way leaves the host in an order nobody asked for, and at the edge
 * that is live traffic following it.
 *
 * The rules keep the priorities they already had — see `rule-order.ts` — so this
 * never creates or deletes a rule, and a reorder that turns out to move nothing
 * costs no writes at all.
 */
export const reorderRules = async (req: ApiRequest): Promise<ApiResponse> => {
  const target = await resolveTarget(req.params.targetId);
  const { host } = req.params;
  const { type, order } = parseReorder(req.body);

  const repo = getRulesRepository(target);

  // Narrowed by the key's prefix rather than by the item's `type` field, even
  // though the server derives one from the other: the prefix is what the edge
  // queries on, so it decides which sequence a rule really runs in. An item
  // whose two disagree — written outside the console — is then still reorderable
  // from the list it appears in, instead of being invisible here and making
  // every order of that host look incomplete.
  const prefix = `${KIND_BY_TYPE[type]}#`;
  const stored = (await repo.listByHost(host)).filter((rule) =>
    rule.sk.startsWith(prefix),
  );

  const { moves, reordered } = planReorder(stored, order);
  if (!(await repo.reorder(moves))) {
    throw new ApiError(
      409,
      "RULES_CHANGED",
      `A rule of host "${host}" was deleted while this order was being applied — nothing was moved. Reload the rules and reorder them again`,
    );
  }

  return json(200, reordered);
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
