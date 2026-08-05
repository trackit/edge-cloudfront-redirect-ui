import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "./api";
import type { ApiClient } from "./api";
import type { Distribution, DistributionDraft } from "./types";

/**
 * Where the connected distributions are kept, and how one comes to exist.
 *
 * localStorage holds only the *links* — which registered targets this browser
 * knows about, and which one is selected. The targets themselves live in the
 * API's registry, so the ids here refer to server state. The ticket defers
 * moving this to the user profile; when that happens it is a change in this
 * module and nowhere else.
 */
const STORAGE_KEY = "edgeroute.distributions";

/**
 * The key this module used when it held a single distribution. Read once, on
 * first load, so a browser that connected before this change keeps its
 * environment instead of being sent back to the connect screen. Not written
 * again — the migration is one-way.
 */
const LEGACY_STORAGE_KEY = "edgeroute.distribution";

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

/**
 * What the browser remembers: every distribution it has connected, and which one
 * the console is currently pointed at.
 *
 * `current` is a `distributionId`, and so is the identity of an entry in the list.
 * Not `targetId`: the API identifies a target by (account, region, table), so two
 * distributions served by the same rules table share one target id. Keying on it
 * would make connecting a second distribution silently overwrite the first, and
 * the design lists distributions — its two rows show the same table.
 *
 * A distribution ID is unique within AWS, so it is the right identity for the
 * thing the user is naming. `targetId` stays on each entry: it is what the rules
 * routes need, and two entries may legitimately carry the same one.
 *
 * Not an index, either — the list is rewritten on every change, and an index
 * would silently point at a different entry after one is replaced.
 */
export interface Stored {
  distributions: Distribution[];
  current: string | null;
}

export const EMPTY: Stored = { distributions: [], current: null };

/**
 * Each entry is validated on its own, and an invalid one is dropped rather than
 * discarding the whole list — one corrupt entry should not cost the user the
 * environments that are still readable.
 *
 * `current` is only kept if it names an entry that survived, so the selection can
 * never point at something that is not in the list.
 */
export const parseStored = (raw: string | null): Stored => {
  if (raw === null) return EMPTY;

  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return EMPTY;

    const { distributions, current } = value as Record<string, unknown>;
    if (!Array.isArray(distributions)) return EMPTY;

    const parsed = distributions
      .map((entry) => parse(JSON.stringify(entry)))
      .filter((entry): entry is Distribution => entry !== null);

    const selected =
      typeof current === "string" &&
      parsed.some((entry) => entry.distributionId === current)
        ? current
        : (parsed[0]?.distributionId ?? null);

    return { distributions: parsed, current: selected };
  } catch {
    return EMPTY;
  }
};

/**
 * Promotes the single-distribution shape this module used to write into a
 * one-entry list. Only consulted when the current key holds nothing, and never
 * written back — see LEGACY_STORAGE_KEY.
 */
export const migrateLegacy = (raw: string | null): Stored => {
  const legacy = parse(raw);
  return legacy === null
    ? EMPTY
    : { distributions: [legacy], current: legacy.distributionId };
};

/**
 * Adds a distribution and selects it. Re-connecting the same distribution ID
 * replaces that entry rather than duplicating it — its table or region may have
 * changed, and two rows naming one distribution is not something the menu could
 * tell apart.
 */
export const reduceConnect = (prev: Stored, value: Distribution): Stored => ({
  distributions: [
    ...prev.distributions.filter(
      (entry) => entry.distributionId !== value.distributionId,
    ),
    value,
  ],
  current: value.distributionId,
});

/**
 * Swaps the selected distribution for an edited one, in place. Settings can
 * change every field including the distribution ID, so this is a replace rather
 * than an update — but it keeps the entry's position so the menu does not
 * reorder under the user.
 */
export const reduceReplaceCurrent = (
  prev: Stored,
  value: Distribution,
): Stored => {
  const at = prev.distributions.findIndex(
    (entry) => entry.distributionId === prev.current,
  );
  if (at === -1) {
    return {
      distributions: [...prev.distributions, value],
      current: value.distributionId,
    };
  }

  const next = [...prev.distributions];
  next[at] = value;
  // Renaming onto an ID another entry already holds would leave two rows the
  // menu cannot tell apart, so the older one goes.
  return {
    distributions: next.filter(
      (entry, i) => i === at || entry.distributionId !== value.distributionId,
    ),
    current: value.distributionId,
  };
};

/** Switches the selection, and only to an entry that is actually in the list. */
export const reduceSelect = (prev: Stored, distributionId: string): Stored =>
  prev.distributions.some((entry) => entry.distributionId === distributionId)
    ? { ...prev, current: distributionId }
    : prev;

const read = (): Stored => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw !== null) return parseStored(raw);

    // Nothing under the current key: fall back to the shape this module used to
    // write before it held a list.
    return migrateLegacy(localStorage.getItem(LEGACY_STORAGE_KEY));
  } catch {
    // Private-browsing modes throw on access rather than returning null.
    return EMPTY;
  }
};

/**
 * The distributions this browser knows about, and the one in use.
 *
 * Every mutation replaces the whole `Stored` value, so the list and the selection
 * can never be persisted out of step with each other.
 *
 * Nothing here deletes a target from the API's registry: it is shared state, and
 * removing it would break anyone else pointed at the same table. Forgetting a
 * distribution locally is all this module does.
 */
export function useDistributions() {
  const [stored, setStored] = useState<Stored>(read);

  const distributions = stored.distributions;
  const current =
    distributions.find((entry) => entry.distributionId === stored.current) ??
    null;

  const connect = useCallback((value: Distribution) => {
    setStored((prev) => reduceConnect(prev, value));
  }, []);

  const replaceCurrent = useCallback((value: Distribution) => {
    setStored((prev) => reduceReplaceCurrent(prev, value));
  }, []);

  const select = useCallback((distributionId: string) => {
    setStored((prev) => reduceSelect(prev, distributionId));
  }, []);

  useEffect(() => {
    try {
      if (stored.distributions.length === 0) {
        localStorage.removeItem(STORAGE_KEY);
      } else {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
      }
      // The legacy single-distribution key is dropped once its content has been
      // carried over, so a later load cannot resurrect a stale environment.
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      // Storage unavailable or full: the console still works for this session.
    }
  }, [stored]);

  return { distributions, current, connect, replaceCurrent, select };
}
