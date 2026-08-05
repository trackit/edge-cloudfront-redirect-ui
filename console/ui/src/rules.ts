import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, isRedirect, priorityOf } from "./api";
import type { Rule, RuleInput } from "./api";

/**
 * Loading and mutating one host's rules.
 *
 * Everything here goes through `api.rules.*`, which owns the URL shape and the
 * percent-encoding a sort key needs. Nothing in this module builds an `sk`: the
 * server derives it from `type` and `priority`, and the value a mutation returns
 * is the authority on where the rule now lives.
 */

/** Redirects and rewrites are separate priority sequences at the edge. */
export interface GroupedRules {
  redirects: Rule[];
  rewrites: Rule[];
}

const byPriority = (a: Rule, b: Rule): number =>
  priorityOf(a.sk) - priorityOf(b.sk);

/**
 * Splits a host's rules the way the edge evaluates them: redirects run at
 * viewer-request and rewrites at origin-request, so they are two independent
 * lists rather than one list with a type column. Each is sorted by priority,
 * which is also the order the API returns — sorted again here so the grouping
 * does not depend on that.
 */
const groupRules = (rules: Rule[]): GroupedRules => ({
  redirects: rules.filter(isRedirect).sort(byPriority),
  rewrites: rules.filter((rule) => !isRedirect(rule)).sort(byPriority),
});

/**
 * The priorities already taken for a rule type, so an editor can reject a
 * collision before spending a request on a 409. The server still enforces it —
 * this only saves the round trip, it is not the guarantee.
 */
export const takenPriorities = (
  rules: Rule[],
  type: Rule["type"],
  except?: string,
): number[] =>
  rules
    .filter((rule) => rule.type === type && rule.sk !== except)
    .map((rule) => priorityOf(rule.sk));

/**
 * One host's rules, with the mutations the console needs.
 *
 * `host` may be empty — no host is selected yet — and that is not an error
 * state: it loads nothing and reports nothing, because there is no request to
 * make. An unknown host, by contrast, is a successful empty list; the API
 * returns `[]` rather than a 404.
 *
 * Every mutation refetches instead of patching local state. A write can move a
 * rule to a new key, and a refetch is one request against a list that is a
 * single-partition query — cheap enough that reconciling by hand would be
 * optimising the wrong thing.
 */
export function useRules(targetId: string, host: string) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  /**
   * Which (target, host) the state belongs to.
   *
   * Nothing cancels an in-flight request, so switching host twice quickly leaves
   * two responses racing: the first host's can land second and overwrite the
   * list under a heading that names the other one. Every write to state is
   * therefore gated on the request still being the current one, and the ref is
   * updated synchronously — a state value would not be readable by a callback
   * that captured the previous render.
   */
  const currentKey = useRef("");
  const key = `${targetId}\u0000${host}`;

  const load = useCallback(async () => {
    currentKey.current = key;

    if (host === "") {
      setRules([]);
      setError(null);
      setLoading(false);
      return;
    }

    // Cleared up front rather than on arrival: the previous host's rules must not
    // stay on screen under the new host's heading, and a failed load must not
    // fall back to showing them either.
    setRules([]);
    setLoading(true);
    setError(null);
    try {
      const loaded = await api.rules.list(targetId, host);
      if (currentKey.current !== key) return;
      setRules(loaded);
    } catch (caught) {
      if (currentKey.current !== key) return;
      setError(asApiError(caught, "Could not load the rules for this host"));
    } finally {
      if (currentKey.current === key) setLoading(false);
    }
  }, [targetId, host, key]);

  useEffect(() => {
    // The promise is deliberately not awaited: `load` handles its own failures
    // into state, so there is nothing left for a rejection handler to do.
    void load();
  }, [load]);

  /**
   * Wraps a write so the list is refetched on success and the caller gets the
   * failure to render next to its own form. Re-thrown rather than pushed into
   * `error`: a modal's validation errors belong in the modal, not in the banner
   * above the list it is covering.
   */
  const mutate = useCallback(
    async <T>(action: () => Promise<T>): Promise<T> => {
      const result = await action();
      await load();
      return result;
    },
    [load],
  );

  const create = useCallback(
    (input: RuleInput) => mutate(() => api.rules.create(targetId, host, input)),
    [mutate, targetId, host],
  );

  /**
   * Full replace. `sk` addresses the rule as it is stored now, while `priority`
   * in the body says where it should end up — passing a changed priority moves
   * the rule, and the response carries its new key.
   */
  const update = useCallback(
    (sk: string, input: RuleInput) =>
      mutate(() => api.rules.put(targetId, host, sk, input)),
    [mutate, targetId, host],
  );

  const toggle = useCallback(
    (rule: Rule) =>
      mutate(() =>
        api.rules.toggle(targetId, host, rule.sk, rule.disabled !== true),
      ),
    [mutate, targetId, host],
  );

  const remove = useCallback(
    (sk: string) => mutate(() => api.rules.remove(targetId, host, sk)),
    [mutate, targetId, host],
  );

  return {
    rules,
    grouped: groupRules(rules),
    loading,
    error,
    reload: load,
    create,
    update,
    toggle,
    remove,
  };
}

/**
 * Anything thrown by the client is already an `ApiError`; this only covers the
 * bug case, so an unexpected throw still renders as a message instead of an
 * empty banner.
 */
export const asApiError = (caught: unknown, fallback: string): ApiError =>
  caught instanceof ApiError
    ? caught
    : new ApiError({
        status: 0,
        code: "MALFORMED_RESPONSE",
        message: fallback,
      });
