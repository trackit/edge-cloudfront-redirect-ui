import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "./api";
import type { ApiClient, HostSummary } from "./api";
import { hostKey } from "./hostRoutes";

/**
 * The host list for a target. Server state, unlike the connected distribution in
 * `distribution.ts`: hosts live in the target's table, shared with anyone else
 * pointed at it, so the only way to see someone else's change is to ask again.
 */
export type HostsState =
  | { status: "loading" }
  | { status: "ready"; hosts: HostSummary[] }
  | { status: "failed"; error: ApiError };

/**
 * What a failed load is shown as. The client rejects with an `ApiError` for
 * anything it could read as one, so whatever else arrives here is a transport
 * fault — a rejected fetch, a body that was not the error envelope — carrying
 * nothing worth showing a user. Hence one sentence, not a stringified exception.
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
 * add up to. Split out of the component because the order the three are tested
 * in *is* the behaviour, and this way it is reachable without a DOM.
 *
 * `current` is compared as given — the caller normalizes the route param — while
 * the list's entries are normalized here rather than trusted: they are `pk`
 * values from the table, and one written before the API lowercased its keys
 * would otherwise report "No such host" for a target's only host.
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
  // Before the membership test: with no host addressed there is nothing to find.
  // Normalized, so this lands on the URL the test below will agree with — a raw
  // key bounces through the canonical redirect and arrives looking unknown.
  if (current === null) return { kind: "redirect", to: hostKey(hosts[0].host) };

  return {
    kind: "host",
    host: current,
    known: hosts.some((entry) => hostKey(entry.host) === current),
  };
};

/**
 * Loads a target's hosts, reloading when the target changes. Every mutation goes
 * through `reload` rather than patching the list here: the counts come from the
 * server, so asking again is the only way the two cannot disagree.
 */
export function useHosts(targetId: string, client: ApiClient = api) {
  const [state, setState] = useState<HostsState>({ status: "loading" });
  // Bumped to ask again. A counter rather than a boolean: two reloads in a row
  // must both run, and a flag flipped back and forth can coalesce into one.
  const [attempt, setAttempt] = useState(0);

  /*
    Drops the list in the same update that asks for a new one. The effect below
    also sets `loading`, but only after the render `setAttempt` schedules — and a
    caller that reloads *and* navigates in one handler routes off the stale list
    first. That is how deleting the first host in the rail used to land on "No
    such host": the hostless URL redirected onto the host just deleted.
  */
  const reload = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);

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
