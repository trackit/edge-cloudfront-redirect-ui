import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../api";
import type { ApiClient, Target } from "../api";
import type { Distribution, DistributionDraft } from "./types";

/**
 * The team's linked distributions, and which one this user is looking at.
 *
 * The list is the API's target registry: one target per linked distribution,
 * named after its distribution ID, so anyone who signs in, from any browser,
 * sees the same distributions (CF-56). Only the *selection* is kept in the
 * browser, under the signed-in user's key, so switching distribution changes
 * nothing for anyone else and the next person on this browser never inherits
 * it.
 */
const SELECTION_KEY_PREFIX = "edgeroute.selected.";

/**
 * Where this module kept the list itself before it moved to the API. Deleted on
 * load and never read: the console was not live yet, so there is nothing to
 * bring over, and a list left behind would outlive the person who linked it.
 */
const RETIRED_STORAGE_KEYS = [
  "edgeroute.distributions",
  "edgeroute.distribution",
];

/**
 * Prefills the link form. Nothing is sent until the user links.
 *
 * Frozen: the link screen hands this straight to `useState`, so it is the live
 * draft rather than a copy of one, and two sessions that reach for the sample
 * share the one object.
 */
export const SAMPLE_DISTRIBUTION: DistributionDraft = Object.freeze({
  distributionId: "E2QWERTY123456",
  tableName: "edgeroute-rules",
  region: "us-east-1",
});

export const emptyDistribution = (): DistributionDraft => ({
  distributionId: "",
  tableName: "",
  region: "us-east-1",
});

/** A registry entry as the console shows it: the name is the distribution ID. */
export const toDistribution = (target: Target): Distribution => ({
  targetId: target.id,
  distributionId: target.name,
  tableName: target.tableName,
  region: target.region,
  ...(target.roleArn ? { roleArn: target.roleArn } : {}),
  ...(target.edgeFunctionArn
    ? { edgeFunctionArn: target.edgeFunctionArn }
    : {}),
});

/**
 * Which distribution a name is, the way the API compares names: the ID, whether
 * the name is the ID or its ARN, and the name itself without case otherwise.
 */
const nameIdentity = (name: string): string => {
  const trimmed = name.trim();
  const fromArn =
    /^arn:aws[a-z-]*:cloudfront::\d{12}:distribution\/(E[A-Z0-9]+)$/.exec(
      trimmed,
    );
  if (fromArn?.[1]) return fromArn[1];
  return /^E[A-Z0-9]{7,}$/.test(trimmed) ? trimmed : trimmed.toUpperCase();
};

const sameName = (a: string, b: string): boolean =>
  nameIdentity(a) === nameIdentity(b);

/**
 * Links the draft's distribution: registers it with the API and returns it with
 * the target id the rules routes need.
 *
 * The distribution may already be linked — a teammate linked it first. That is
 * a 409, and a success for what the user asked for when it points at the same
 * table, so the existing target is looked up by name and reused. Linked to
 * another table, it is not the same request, and the 409 stands.
 */
export const linkDistribution = async (
  draft: DistributionDraft,
  client: ApiClient = api,
): Promise<Distribution> => {
  const edgeFunctionArn = draft.edgeFunctionArn?.trim() || undefined;
  const input = {
    name: draft.distributionId,
    region: draft.region,
    tableName: draft.tableName,
    ...(edgeFunctionArn ? { edgeFunctionArn } : {}),
  };

  try {
    return toDistribution(await client.targets.create(input));
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "TARGET_EXISTS") {
      throw error;
    }

    const existing = (await client.targets.list()).find((t) =>
      sameName(t.name, draft.distributionId),
    );

    // Gone between the two calls, or linked to another table: either way the
    // server's own refusal is the truthful answer.
    if (
      existing === undefined ||
      existing.region !== draft.region ||
      existing.tableName !== draft.tableName
    ) {
      throw error;
    }

    // Linking again reuses the registered target as it is, so a function ARN
    // typed now would otherwise never reach the API.
    if (edgeFunctionArn && existing.edgeFunctionArn !== edgeFunctionArn) {
      return toDistribution(
        await client.targets.update(existing.id, {
          name: existing.name,
          region: existing.region,
          tableName: existing.tableName,
          ...(existing.roleArn ? { roleArn: existing.roleArn } : {}),
          edgeFunctionArn,
        }),
      );
    }

    return toDistribution(existing);
  }
};

/**
 * Saves Settings onto the linked distribution's target, for everyone. A full
 * replace on the API side, so the role, which the form does not edit, is sent
 * back as it was rather than cleared. The function ARN is the form's: emptied
 * there, it is removed.
 */
export const updateDistribution = async (
  current: Distribution,
  draft: DistributionDraft,
  client: ApiClient = api,
): Promise<Distribution> => {
  const edgeFunctionArn = draft.edgeFunctionArn?.trim() || undefined;
  return toDistribution(
    await client.targets.update(current.targetId, {
      name: draft.distributionId,
      region: draft.region,
      tableName: draft.tableName,
      ...(current.roleArn ? { roleArn: current.roleArn } : {}),
      ...(edgeFunctionArn ? { edgeFunctionArn } : {}),
    }),
  );
};

/**
 * Unlinks a distribution for the whole team. Registry only: its rules table is
 * never touched, so the distribution stays live at the edge. Already gone — a
 * teammate unlinked it first — is the outcome asked for, not an error.
 */
export const unlinkDistribution = async (
  distribution: Distribution,
  client: ApiClient = api,
): Promise<void> => {
  try {
    await client.targets.remove(distribution.targetId);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return;
    throw error;
  }
};

/**
 * The selected distribution: the one the user picked, or the first one when
 * that is gone — a teammate unlinked it — or none was picked yet.
 */
export const resolveCurrent = (
  distributions: readonly Distribution[],
  selected: string | null,
): Distribution | null =>
  distributions.find((entry) => entry.targetId === selected) ??
  distributions[0] ??
  null;

/**
 * Where unlinking lands: the distribution after the one removed, or the one
 * before it when it was the last. None left is the link screen.
 */
export const nextAfterUnlink = (
  distributions: readonly Distribution[],
  removedId: string,
): string | null => {
  const at = distributions.findIndex((entry) => entry.targetId === removedId);
  const rest = distributions.filter((entry) => entry.targetId !== removedId);
  if (rest.length === 0) return null;
  return (rest[Math.min(Math.max(at, 0), rest.length - 1)] ?? rest[0]).targetId;
};

/** Adds a linked distribution, or replaces the entry it already has. */
export const withLinked = (
  distributions: readonly Distribution[],
  value: Distribution,
): Distribution[] => {
  const at = distributions.findIndex(
    (entry) => entry.targetId === value.targetId,
  );
  if (at === -1) return [...distributions, value];
  const next = [...distributions];
  next[at] = value;
  return next;
};

/**
 * What a failed load is shown as. Anything that is not an `ApiError` is a
 * transport fault carrying nothing worth showing a user.
 */
export const toDistributionsError = (error: unknown): ApiError =>
  error instanceof ApiError
    ? error
    : new ApiError({
        status: 0,
        code: "MALFORMED_RESPONSE",
        message: "Something went wrong loading the distributions",
      });

export type DistributionsState =
  | { status: "loading" }
  | { status: "ready"; distributions: readonly Distribution[] }
  | { status: "failed"; error: ApiError };

const readSelection = (key: string | null): string | null => {
  if (key === null) return null;
  try {
    return localStorage.getItem(key);
  } catch {
    // Private-browsing modes throw on access rather than returning null.
    return null;
  }
};

const writeSelection = (key: string | null, targetId: string | null): void => {
  if (key === null) return;
  try {
    if (targetId === null) localStorage.removeItem(key);
    else localStorage.setItem(key, targetId);
  } catch {
    // Storage unavailable: the selection still holds for this page.
  }
};

const dropRetiredKeys = (): void => {
  try {
    for (const key of RETIRED_STORAGE_KEYS) localStorage.removeItem(key);
  } catch {
    // Nothing to clean up where storage cannot be reached.
  }
};

/**
 * The team's distributions, loaded once per console load, and the one selected.
 *
 * `userKey` identifies the signed-in user — the selection is theirs, not the
 * browser's. Without one the selection lasts only for this page.
 */
export function useDistributions(
  userKey: string | undefined,
  client: ApiClient = api,
) {
  const storageKey = userKey ? `${SELECTION_KEY_PREFIX}${userKey}` : null;
  const [state, setState] = useState<DistributionsState>({
    status: "loading",
  });
  const [selected, setSelected] = useState<string | null>(() =>
    readSelection(storageKey),
  );
  const [attempt, setAttempt] = useState(0);
  // Targets the API has said are gone. The list is a Scan, eventually
  // consistent, so right after a teammate's delete it can still return one —
  // which, selected, would 404 again and reload again until the Scan caught up.
  const gone = useRef(new Set<string>());

  const reload = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  /** The API no longer knows this target: drop it and ask for the list again. */
  const forget = useCallback(
    (targetId: string) => {
      gone.current.add(targetId);
      reload();
    },
    [reload],
  );

  useEffect(() => {
    dropRetiredKeys();
  }, []);

  // A different user on the same page reads their own selection, never the
  // previous one's.
  useEffect(() => {
    setSelected(readSelection(storageKey));
  }, [storageKey]);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });

    client.targets.list().then(
      (targets) => {
        if (!cancelled) {
          setState({
            status: "ready",
            distributions: targets
              .filter((target) => !gone.current.has(target.id))
              .map(toDistribution),
          });
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setState({ status: "failed", error: toDistributionsError(error) });
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [client, attempt]);

  const distributions = state.status === "ready" ? state.distributions : [];
  const current = resolveCurrent(distributions, selected);

  const select = useCallback(
    (targetId: string | null) => {
      setSelected(targetId);
      writeSelection(storageKey, targetId);
    },
    [storageKey],
  );

  /** A distribution just linked, or saved from Settings: listed and selected. */
  const linked = useCallback(
    (value: Distribution) => {
      setState((prev) =>
        prev.status === "ready"
          ? {
              status: "ready",
              distributions: withLinked(prev.distributions, value),
            }
          : prev,
      );
      select(value.targetId);
    },
    [select],
  );

  /** Unlinks the selected distribution for everyone and moves to the next one. */
  const unlinkCurrent = useCallback(async () => {
    if (current === null) return;
    await unlinkDistribution(current, client);
    // Gone for this page too: a stale Scan on a later reload must not bring it
    // back.
    gone.current.add(current.targetId);
    const next = nextAfterUnlink(distributions, current.targetId);
    // From the list as it is now, not as it was when the unlink started: a
    // reload may have landed while the request was in flight.
    setState((prev) =>
      prev.status === "ready"
        ? {
            status: "ready",
            distributions: prev.distributions.filter(
              (entry) => entry.targetId !== current.targetId,
            ),
          }
        : prev,
    );
    select(next);
  }, [current, distributions, client, select]);

  return { state, current, reload, forget, select, linked, unlinkCurrent };
}
