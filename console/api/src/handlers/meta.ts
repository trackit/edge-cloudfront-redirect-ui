import type { ApiResponse } from "../context.js";
import { getAllowedRegions } from "../lib/aws-regions.js";
import { json } from "../lib/respond.js";

/**
 * GET /meta — what this deployment will accept, for a client that would
 * otherwise have to guess.
 *
 * Only `regions` so far, and it exists because guessing went wrong: the console
 * shipped its own shortlist of regions for the target form, while
 * `ALLOWED_REGIONS` replaces the API's list entirely. The two cannot be kept in
 * step by hand — a deployment narrowing its regions cannot edit the front end —
 * so the console offered choices the API rejected and hid ones it would have
 * taken (CF-34).
 *
 * Sorted, because this is rendered as a list and the environment variable's
 * order is whatever an operator happened to type.
 */
export const meta = (): ApiResponse =>
  json(200, { regions: [...getAllowedRegions()].sort() });
