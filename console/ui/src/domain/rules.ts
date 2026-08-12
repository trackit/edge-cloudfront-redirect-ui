import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, isRedirect, priorityOf } from "../api";
import type { Rule, RuleInput } from "../api";

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

/** One rule to import, and the host it belongs to (its own, or the target). */
export interface ImportItem {
  host: string;
  input: RuleInput;
}

/**
 * The tally an import returns: how many rules were created, and which items (by
 * their position in the batch) the API refused, with why. A partial success is
 * the expected shape, not an error — some rows can land while others fail.
 */
export interface ImportOutcome {
  created: number;
  failures: { index: number; message: string }[];
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

  const load = useCallback(
    async (options?: { keepVisible?: boolean }) => {
      currentKey.current = key;

      if (host === "") {
        setRules([]);
        setError(null);
        setLoading(false);
        return;
      }

      // A host switch clears up front: the previous host's rules must not stay
      // on screen under the new host's heading, and a failed load must not fall
      // back to showing them. A refetch after a write passes `keepVisible`
      // instead — the host has not changed, so the list stays put and only its
      // contents update when the response lands. That is what lets the mutating
      // row show its own busy state rather than the whole list flashing to
      // skeletons for a change as small as a toggle.
      if (options?.keepVisible !== true) {
        setRules([]);
        setLoading(true);
      }
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
    },
    [targetId, host, key],
  );

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
      // Kept visible: the host has not changed, so refetch in place rather than
      // blanking the list the user is still looking at.
      await load({ keepVisible: true });
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

  /**
   * Creates many rules from an import, one request each — there is no bulk route.
   *
   * Rules can land on several hosts (a rule may name its own), and priorities are
   * per host, so the items are grouped by host and each host's live rules are
   * read once to place the batch after its current maximum. Assigning here rather
   * than in the parser is the only way the numbers can be right: the parser never
   * sees a host it is not already looking at.
   *
   * Sequential, not `Promise.all` — the priorities within a host are consecutive,
   * and firing them at once would race the server's uniqueness check. A failure
   * does not abort the run: each is caught and reported by its position in the
   * batch, so one rejection does not cost the rows after it. One refetch at the
   * end reflects the true final state; `mutate`'s per-write refetch would fire
   * once per rule.
   */
  const importRules = useCallback(
    async (items: ImportItem[]): Promise<ImportOutcome> => {
      const failures: ImportOutcome["failures"] = [];
      let created = 0;

      const byHost = new Map<string, { index: number; input: RuleInput }[]>();
      items.forEach((item, index) => {
        const group = byHost.get(item.host) ?? [];
        group.push({ index, input: item.input });
        byHost.set(item.host, group);
      });

      for (const [ruleHost, group] of byHost) {
        let cursor = 0;
        const used = new Set<number>();
        try {
          const existing = await api.rules.list(targetId, ruleHost);
          for (const priority of takenPriorities(existing, "erMatchRule")) {
            used.add(priority);
          }
          if (used.size > 0) cursor = Math.max(...used) + 1;
        } catch {
          // Could not read the host's rules — start from zero and let any real
          // collision surface as a per-row failure below rather than aborting.
        }

        for (const { index, input } of group) {
          while (used.has(cursor)) cursor++;
          const priority = cursor++;
          used.add(priority);
          try {
            await api.rules.create(targetId, ruleHost, { ...input, priority });
            created++;
          } catch (caught) {
            const err = asApiError(caught, "Could not create this rule");
            failures.push({
              index,
              message:
                err.code === "RULE_EXISTS"
                  ? "priority already in use (created concurrently?)"
                  : err.message,
            });
          }
        }
      }

      await load();
      return { created, failures };
    },
    [targetId, load],
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
    importRules,
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
