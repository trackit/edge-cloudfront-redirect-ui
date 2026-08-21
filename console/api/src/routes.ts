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
 *
 * `write: true` is the whole of role-based access (ER-205): a viewer may reach
 * every route without it and none with it. Reading down the column is how you
 * check that, which is why the flag lives here rather than inside the handlers.
 * A new route is protected and read-only unless it says otherwise — the safe
 * default is the one you get by forgetting.
 */
export const routes: Route[] = [
  { method: "GET", pattern: "/health", handler: health, public: true },

  { method: "GET", pattern: "/targets", handler: listTargets },
  { method: "POST", pattern: "/targets", handler: createTarget, write: true },
  { method: "GET", pattern: "/targets/:id", handler: getTarget },
  {
    method: "PUT",
    pattern: "/targets/:id",
    handler: updateTarget,
    write: true,
  },
  {
    method: "DELETE",
    pattern: "/targets/:id",
    handler: deleteTarget,
    write: true,
  },

  { method: "GET", pattern: HOSTS, handler: listHosts },
  { method: "POST", pattern: HOSTS, handler: createHost, write: true },
  { method: "DELETE", pattern: HOST, handler: deleteHost, write: true },

  { method: "GET", pattern: RULES, handler: listRules },
  { method: "POST", pattern: RULES, handler: createRule, write: true },
  { method: "GET", pattern: `${RULES}/:sk`, handler: getRule },
  { method: "PUT", pattern: `${RULES}/:sk`, handler: putRule, write: true },
  {
    method: "PATCH",
    pattern: `${RULES}/:sk`,
    handler: toggleRule,
    write: true,
  },
  {
    method: "DELETE",
    pattern: `${RULES}/:sk`,
    handler: deleteRule,
    write: true,
  },
];
