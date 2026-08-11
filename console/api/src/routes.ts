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
  toggleRule,
} from "./handlers/rules.js";
import { createHost, deleteHost, listHosts } from "./handlers/hosts.js";

const HOSTS = "/targets/:targetId/hosts";
const HOST = `${HOSTS}/:host`;
const RULES = `${HOST}/rules`;

/**
 * The route table. Targets registry (ER-202) and rules CRUD plus the `disabled`
 * toggle (ER-203) are live.
 */
export const routes: Route[] = [
  { method: "GET", pattern: "/health", handler: health },

  { method: "GET", pattern: "/targets", handler: listTargets },
  { method: "POST", pattern: "/targets", handler: createTarget },
  { method: "GET", pattern: "/targets/:id", handler: getTarget },
  { method: "PUT", pattern: "/targets/:id", handler: updateTarget },
  { method: "DELETE", pattern: "/targets/:id", handler: deleteTarget },

  { method: "GET", pattern: HOSTS, handler: listHosts },
  { method: "POST", pattern: HOSTS, handler: createHost },
  { method: "DELETE", pattern: HOST, handler: deleteHost },

  { method: "GET", pattern: RULES, handler: listRules },
  { method: "POST", pattern: RULES, handler: createRule },
  { method: "GET", pattern: `${RULES}/:sk`, handler: getRule },
  { method: "PUT", pattern: `${RULES}/:sk`, handler: putRule },
  { method: "PATCH", pattern: `${RULES}/:sk`, handler: toggleRule },
  { method: "DELETE", pattern: `${RULES}/:sk`, handler: deleteRule },
];
