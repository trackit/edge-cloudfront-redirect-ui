import type { Route } from "./router.js";
import { health } from "./handlers/health.js";
import {
  createTarget,
  deleteTarget,
  getTarget,
  listTargets,
  updateTarget,
} from "./handlers/targets.js";
import {
  createRule,
  deleteRule,
  getRule,
  listRules,
  putRule,
} from "./handlers/rules.js";

const RULES = "/targets/:targetId/hosts/:host/rules";

/**
 * The route table. Targets registry (ER-202) and rule list/fetch/create/update/
 * delete (ER-203) are live; the `disabled` toggle is the remaining rule route.
 */
export const routes: Route[] = [
  { method: "GET", pattern: "/health", handler: health },

  { method: "GET", pattern: "/targets", handler: listTargets },
  { method: "POST", pattern: "/targets", handler: createTarget },
  { method: "GET", pattern: "/targets/:id", handler: getTarget },
  { method: "PUT", pattern: "/targets/:id", handler: updateTarget },
  { method: "DELETE", pattern: "/targets/:id", handler: deleteTarget },

  { method: "GET", pattern: RULES, handler: listRules },
  { method: "POST", pattern: RULES, handler: createRule },
  { method: "GET", pattern: `${RULES}/:sk`, handler: getRule },
  { method: "PUT", pattern: `${RULES}/:sk`, handler: putRule },
  { method: "DELETE", pattern: `${RULES}/:sk`, handler: deleteRule },
];
