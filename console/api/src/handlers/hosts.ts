import type { ApiRequest, ApiResponse } from "../context.js";
import { json } from "../lib/respond.js";
import { getRulesRepository } from "../lib/rules-repository.js";
import { resolveTarget } from "../lib/targets-repository.js";

/**
 * The hosts in a target's table — what the console's host list is built from.
 *
 * Separate from handlers/rules.ts because a host is not a rule: these routes
 * address the partition itself, and everything under `/hosts/{host}/rules`
 * addresses items inside one.
 */
export const listHosts = async (req: ApiRequest): Promise<ApiResponse> => {
  const target = await resolveTarget(req.params.targetId);
  const hosts = await getRulesRepository(target).listHosts();

  // Sorted here rather than in the repository, for the same reason listRules is:
  // the order is a property of the endpoint, not of whichever repository
  // answered. A Scan has no meaningful order of its own to preserve.
  hosts.sort((a, b) => a.host.localeCompare(b.host));
  return json(200, hosts);
};
