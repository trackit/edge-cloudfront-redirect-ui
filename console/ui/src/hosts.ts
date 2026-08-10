import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "./api";
import type { ApiClient, HostSummary } from "./api";

/**
 * The host list for a target, and how it is loaded.
 *
 * Hosts are server state, unlike the connected distribution in `distribution.ts`
 * — nothing about them is kept in this browser. They come from the target's
 * DynamoDB table, so they are shared with anyone else pointed at it, and the
 * only way to see a change someone else made is to ask again.
 */
export type HostsState =
  | { status: "loading" }
  | { status: "ready"; hosts: HostSummary[] }
  | { status: "failed"; error: ApiError };

/**
 * What a failed load is shown as.
 *
 * The client rejects with an `ApiError` for anything it could read as one, so
 * anything else reaching here is a fault in the transport rather than a refusal
 * the server described — a rejected fetch, or a body that was not the error
 * envelope. Those carry nothing worth putting in front of a user, so they become
 * one sentence rather than a stringified exception.
 */
export const toHostsError = (error: unknown): ApiError =>
  error instanceof ApiError
    ? error
    : new ApiError({
        status: 0,
        code: "MALFORMED_RESPONSE",
        message: "Something went wrong loading the hosts",
      });

/**
 * Which of the console's three host views a loaded list and the addressed host
 * add up to.
 *
 * Split out of the component because it is the console's routing decision, not
 * its markup: an empty target, a URL naming no host, and a URL naming one that
 * is not in the list are three different answers, and the order they are tested
 * in is the whole of the behaviour. Reachable without a DOM this way.
 *
 * `current` is compared as given — the caller lowercases the route param, since
 * a host's identity is case-insensitive and the API stores it normalized.
 */
export type HostView =
  /** No hosts at all: the rail stays, the main area invites adding one. */
  | { kind: "empty" }
  /** Hosts exist but the URL names none, so land on the first. */
  | { kind: "redirect"; to: string }
  /** A host is addressed. `known` is false for a stale or mistyped one. */
  | { kind: "host"; host: string; known: boolean };

export const resolveHostView = (
  hosts: readonly HostSummary[],
  current: string | null,
): HostView => {
  if (hosts.length === 0) return { kind: "empty" };
  // Before the membership test, not after: with no host addressed there is
  // nothing to find in the list, and `hosts[0]` is only safe once the list is
  // known to be non-empty.
  if (current === null) return { kind: "redirect", to: hosts[0].host };

  return {
    kind: "host",
    host: current,
    known: hosts.some((entry) => entry.host === current),
  };
};

/**
 * Loads a target's hosts, reloading when the target changes.
 *
 * `reload` is what every mutation in this list goes through: the counts come
 * from the server, so after adding or deleting a host the honest thing is to ask
 * for the list again rather than patch it here and hope the two agree.
 */
export function useHosts(targetId: string, client: ApiClient = api) {
  const [state, setState] = useState<HostsState>({ status: "loading" });
  // Bumped to ask again. A counter rather than a boolean: two reloads in a row
  // must both run, and a flag flipped back and forth can coalesce into one.
  const [attempt, setAttempt] = useState(0);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    // Switching targets while a request is in flight would otherwise let the old
    // target's hosts land in the new target's list.
    let cancelled = false;
    setState({ status: "loading" });

    client.hosts.list(targetId).then(
      (hosts) => {
        if (!cancelled) setState({ status: "ready", hosts });
      },
      (error: unknown) => {
        if (cancelled) return;
        setState({ status: "failed", error: toHostsError(error) });
      },
    );

    return () => {
      cancelled = true;
    };
  }, [targetId, client, attempt]);

  return { state, reload };
}
