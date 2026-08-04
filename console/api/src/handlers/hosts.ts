import type { ApiRequest, ApiResponse } from "../context.js";
import { ApiError } from "../lib/errors.js";
import { json } from "../lib/respond.js";
import { getRulesRepository } from "../lib/rules-repository.js";
import { resolveTarget } from "../lib/targets-repository.js";
import { validateHost } from "../lib/validate-host.js";

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

/**
 * Creates a host before it has any rules, so the console can add one and have it
 * still be there after a refresh.
 *
 * Answers the same shape `listHosts` returns, with both counts at zero, so the
 * console can put the new host straight into its list without re-fetching.
 */
export const createHost = async (req: ApiRequest): Promise<ApiResponse> => {
  const target = await resolveTarget(req.params.targetId);
  const host = validateHost(req.body);

  if (!(await getRulesRepository(target).createHost(host))) {
    throw new ApiError(
      409,
      "HOST_EXISTS",
      `Host "${host}" already exists in this target`,
    );
  }

  return json(201, { host, redirects: 0, rewrites: 0 });
};

/**
 * Removes a host by removing every rule under it — there is nothing else to it.
 *
 * A host with no rules is a 404 rather than a 204: the two are the same state
 * (nothing stored under that partition key), and answering 204 would tell the
 * console it just deleted something that was never there, hiding a typo'd or
 * already-deleted host behind a success.
 *
 * Unlike `deleteTarget`, this destroys data. The target's table survives; its
 * rules for this host do not.
 */
export const deleteHost = async (req: ApiRequest): Promise<ApiResponse> => {
  const target = await resolveTarget(req.params.targetId);
  const { host } = req.params;

  const deleted = await getRulesRepository(target).deleteHost(host);
  if (deleted === 0) {
    throw ApiError.notFound(`No rules for host "${host}" in this target`);
  }

  return json(204, undefined);
};
