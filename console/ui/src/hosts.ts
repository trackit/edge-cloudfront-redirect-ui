import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "./api";
import type { ApiClient, HostSummary } from "./api";
import { hostKey } from "./hostRoutes";

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
 * `current` is compared as given: the caller normalizes the route param, which is
 * the one host that arrives from outside the app. The list's own entries are
 * normalized here instead of being trusted, because they are `pk` values read
 * straight out of the table — anything written before the API lowercased its keys
 * still carries the case it was stored with, and comparing those verbatim reports
 * "No such host" for the only host a target has.
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
  // Normalized, so the URL this lands on is the one the membership test below
  // will then agree with. Sending the raw key would bounce through the canonical
  // redirect and arrive as a host the list appears not to contain.
  if (current === null) return { kind: "redirect", to: hostKey(hosts[0].host) };

  return {
    kind: "host",
    host: current,
    known: hosts.some((entry) => hostKey(entry.host) === current),
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

  /*
    Drops the list as well as asking for a new one, in the same update.

    The effect below also sets `loading`, but not until after the render that
    `setAttempt` schedules — and a caller that reloads *and* navigates in one
    handler gets that render first. It would decide where to go from a list it
    has already been told is out of date: deleting the first host in the rail
    navigated to the hostless URL, which redirected onto `hosts[0]` — the host
    just deleted — and settled there reporting "No such host".

    Nothing may route off this list once a reload is asked for, so the state that
    says "unknown" has to arrive with the request.
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
