import type { Route } from "./router.js";
import { health } from "./handlers/health.js";

/**
 * The route table. Rule CRUD under `/targets/:targetId/hosts/:host/rules`
 * lands in later ER-201 steps and ER-203; for now only the health probe.
 */
export const routes: Route[] = [
  { method: "GET", pattern: "/health", handler: health },
];
