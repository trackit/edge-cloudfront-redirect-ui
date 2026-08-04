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
        setState({
          status: "failed",
          error:
            error instanceof ApiError
              ? error
              : new ApiError({
                  status: 0,
                  code: "MALFORMED_RESPONSE",
                  message: "Something went wrong loading the hosts",
                }),
        });
      },
    );

    return () => {
      cancelled = true;
    };
  }, [targetId, client, attempt]);

  return { state, reload };
}
