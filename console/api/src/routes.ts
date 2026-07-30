import type { Route } from "./router.js";
import { health } from "./handlers/health.js";
import {
  createRule,
  deleteRule,
  getRule,
  listRules,
  putRule,
} from "./handlers/rules.js";

const RULES = "/targets/:targetId/hosts/:host/rules";

/**
 * The route table, target-scoped per the OpenAPI spec. Rule handlers validate
 * their bodies but defer persistence to ER-203 (they 501).
 */
export const routes: Route[] = [
  { method: "GET", pattern: "/health", handler: health },
  { method: "GET", pattern: RULES, handler: listRules },
  { method: "POST", pattern: RULES, handler: createRule },
  { method: "GET", pattern: `${RULES}/:sk`, handler: getRule },
  { method: "PUT", pattern: `${RULES}/:sk`, handler: putRule },
  { method: "DELETE", pattern: `${RULES}/:sk`, handler: deleteRule },
];
