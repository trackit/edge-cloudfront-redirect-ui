import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { GeoCheck, MatchCondition } from "../api";

export interface GeoCheckBody {
  kind: "redirect" | "rewrite";
  matches: MatchCondition[];
}

/** How long an answer is reused. Past it, or on "Re-check", the API is asked again. */
const TTL_MS = 120_000;
/** How long the editor waits for the conditions to settle before asking. */
const DEBOUNCE_MS = 300;
/** Past this a check counts as failed, so a save waiting on it is not stuck. */
const TIMEOUT_MS = 15_000;

/**
 * The editor's memory of geo checks, keyed on the rule's conditions — the
 * answer depends on its path, not only on the target. Bounded in time so a
 * distribution fixed meanwhile is seen without a reload, and a failed request
 * is forgotten so the next one retries. Pure, so its rules are tested without
 * React.
 */
export const createGeoCheckStore = ({
  fetch,
  now = Date.now,
  ttlMs = TTL_MS,
  timeoutMs = TIMEOUT_MS,
}: {
  fetch: (
    targetId: string,
    body: GeoCheckBody,
    fresh: boolean,
  ) => Promise<GeoCheck>;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
}) => {
  const entries = new Map<string, { at: number; request: Promise<GeoCheck> }>();
  const keyOf = (targetId: string, body: GeoCheckBody): string =>
    `${targetId} ${JSON.stringify(body)}`;

  const ask = (
    targetId: string,
    body: GeoCheckBody,
    fresh: boolean,
  ): Promise<GeoCheck> => {
    const key = keyOf(targetId, body);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(new Error("The distribution check did not answer in time")),
        timeoutMs,
      );
    });
    const request = Promise.race([fetch(targetId, body, fresh), timeout])
      .finally(() => clearTimeout(timer))
      .catch((caught: unknown) => {
        if (entries.get(key)?.request === request) entries.delete(key);
        throw caught;
      });
    entries.set(key, { at: now(), request });
    return request;
  };

  return {
    get: (targetId: string, body: GeoCheckBody): Promise<GeoCheck> => {
      const entry = entries.get(keyOf(targetId, body));
      return entry && now() - entry.at < ttlMs
        ? entry.request
        : ask(targetId, body, false);
    },
    refresh: (targetId: string, body: GeoCheckBody): Promise<GeoCheck> =>
      ask(targetId, body, true),
    clear: (): void => entries.clear(),
  };
};

const store = createGeoCheckStore({
  fetch: (targetId, body, fresh) => api.targets.geoCheck(targetId, body, fresh),
});

/** For tests: forgets every answer, as a page load would. */
export const resetGeoReadiness = (): void => store.clear();

/**
 * - `idle`: the rule reads no country, so nothing was asked.
 * - `loading`: asked, or about to be; `settled` resolves with the answer, or
 *   `null` when there will be none — what a save waits on. `previous` is the
 *   last answer, still shown meanwhile so the notice does not flicker.
 * - `ready`: the API's reading and its decision for this rule.
 * - `failed`: the request itself failed (offline, 5xx). Treated like a
 *   distribution that could not be checked.
 */
export type GeoCheckState =
  | { status: "idle" }
  | {
      status: "loading";
      settled: Promise<GeoCheck | null>;
      previous: GeoCheck | null;
    }
  | { status: "ready"; check: GeoCheck }
  | { status: "failed"; message: string };

/**
 * The API's decision for the rule being edited, asked once its conditions have
 * been still for a moment, and only once `enabled` — the editor enables it when
 * the rule gains a country condition, so a console that never writes one never
 * calls CloudFront. `recheck` asks the API for a fresh reading.
 */
export function useGeoCheck(
  targetId: string,
  kind: GeoCheckBody["kind"],
  matches: MatchCondition[],
  enabled: boolean,
): { state: GeoCheckState; recheck: () => void } {
  const [state, setState] = useState<GeoCheckState>({ status: "idle" });
  const [nonce, setNonce] = useState(0);
  const fresh = useRef(false);
  const last = useRef<GeoCheck | null>(null);
  const body = JSON.stringify({ kind, matches });

  useEffect(() => {
    if (!enabled) {
      last.current = null;
      setState({ status: "idle" });
      return;
    }

    let current = true;
    let settle: (check: GeoCheck | null) => void = () => {};
    const settled = new Promise<GeoCheck | null>((resolve) => {
      settle = resolve;
    });
    setState({ status: "loading", settled, previous: last.current });

    const timer = setTimeout(() => {
      const parsed = JSON.parse(body) as GeoCheckBody;
      const request = fresh.current
        ? store.refresh(targetId, parsed)
        : store.get(targetId, parsed);
      fresh.current = false;
      request.then(
        (check) => {
          settle(check);
          if (current) {
            last.current = check;
            setState({ status: "ready", check });
          }
        },
        (caught: unknown) => {
          settle(null);
          if (current) {
            setState({
              status: "failed",
              message:
                caught instanceof Error
                  ? caught.message
                  : "The check did not answer",
            });
          }
        },
      );
    }, DEBOUNCE_MS);

    return () => {
      current = false;
      clearTimeout(timer);
      // A save waiting on a check that will not happen is not left hanging.
      settle(null);
    };
  }, [targetId, body, enabled, nonce]);

  return {
    state,
    recheck: () => {
      fresh.current = true;
      setNonce((n) => n + 1);
    },
  };
}
