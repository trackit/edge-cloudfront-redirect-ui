import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "./api";
import type { ApiClient } from "./api";
import type { Distribution, DistributionDraft } from "./types";

/**
 * Where the connected distribution is kept, and how one comes to exist.
 *
 * localStorage holds only the *link* — which registered target this browser is
 * pointed at. The target itself lives in the API's registry, so the id here
 * refers to server state. The ticket defers moving this to the user profile;
 * when that happens it is a change in this module and nowhere else.
 */
const STORAGE_KEY = "edgeroute.distribution";

/** Prefills the connect form. Nothing is sent until the user connects. */
export const SAMPLE_DISTRIBUTION: DistributionDraft = {
  distributionId: "E2QWERTY123456",
  tableName: "edgeroute-rules",
  region: "us-east-1",
};

export const emptyDistribution = (): DistributionDraft => ({
  distributionId: "",
  tableName: "",
  region: "us-east-1",
});

/**
 * Registers the draft's table with the API and returns the connected
 * distribution, carrying the target id the rules routes need.
 *
 * The table may already be registered — someone else connected it, or this
 * browser cleared its storage. That is a 409, and it is a success case for the
 * user's intent ("point me at this table"), so the existing target is looked up
 * and reused rather than surfaced as an error. The registry dedupes on
 * (account, region, tableName), so matching on region and table name finds the
 * same entry the server refused to duplicate.
 *
 * `name` is the distribution ID because the API requires a name and the form
 * collects none; the API has no field for a distribution, so this is where it
 * goes.
 */
export const connectDistribution = async (
  draft: DistributionDraft,
  client: ApiClient = api,
): Promise<Distribution> => {
  const input = {
    name: draft.distributionId,
    region: draft.region,
    tableName: draft.tableName,
  };

  try {
    const target = await client.targets.create(input);
    return { ...draft, targetId: target.id };
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "TARGET_EXISTS") {
      throw error;
    }

    const existing = (await client.targets.list()).find(
      (t) => t.region === draft.region && t.tableName === draft.tableName,
    );

    // The 409 said it exists but the list does not show it: the caller cannot
    // act on that, so report the original refusal rather than inventing a
    // reason. Only reachable if the registry changed between the two calls.
    if (existing === undefined) throw error;

    return { ...draft, targetId: existing.id };
  }
};

/**
 * A stored value is whatever was in localStorage last time, which is not
 * necessarily a Distribution — a half-written key, or a shape from an older
 * build that predates `targetId`. Anything not carrying all four fields as
 * strings is treated as absent, so a stale entry shows the connect screen again
 * instead of rendering a console that cannot address any rules.
 */
const parse = (raw: string | null): Distribution | null => {
  if (raw === null) return null;

  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;

    const { targetId, distributionId, tableName, region } = value as Record<
      string,
      unknown
    >;
    if (
      typeof targetId !== "string" ||
      typeof distributionId !== "string" ||
      typeof tableName !== "string" ||
      typeof region !== "string"
    ) {
      return null;
    }

    return { targetId, distributionId, tableName, region };
  } catch {
    return null;
  }
};

const read = (): Distribution | null => {
  try {
    return parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    // Private-browsing modes throw on access rather than returning null.
    return null;
  }
};

/**
 * The connected distribution, or `null` when the console has nothing configured.
 *
 * `disconnect` forgets the link locally and leaves the target registered — the
 * registry is shared state, and removing it would break anyone else pointed at
 * the same table.
 */
export function useDistribution() {
  const [distribution, setDistribution] = useState<Distribution | null>(read);

  const connect = useCallback((value: Distribution) => {
    setDistribution(value);
  }, []);

  const disconnect = useCallback(() => {
    setDistribution(null);
  }, []);

  useEffect(() => {
    try {
      if (distribution === null) {
        localStorage.removeItem(STORAGE_KEY);
      } else {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(distribution));
      }
    } catch {
      // Storage unavailable or full: the console still works for this session.
    }
  }, [distribution]);

  return { distribution, connect, disconnect };
}
