import type { ApiResponse } from "../context.js";
import { json } from "../lib/respond.js";

/** GET /health — liveness probe, unauthenticated. */
export const health = (): ApiResponse => json(200, { status: "ok" });
