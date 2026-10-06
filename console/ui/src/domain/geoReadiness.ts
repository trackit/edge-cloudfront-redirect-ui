import { useEffect, useState } from "react";
import { api } from "../api";
import type { GeoReadiness } from "../api";

/**
 * One request per target per session, shared by every editor that asks. The
 * distribution's cache settings change on a deploy, not while someone edits a
 * rule, and the API reuses its own answer for a minute anyway.
 */
const requests = new Map<string, Promise<GeoReadiness>>();

const readinessOf = (targetId: string): Promise<GeoReadiness> => {
  let request = requests.get(targetId);
  if (!request) {
    // Only the distribution's reading is used here; the rule-specific
    // decision the endpoint also returns is wired into the editor separately.
    request = api.targets
      .geoCheck(targetId, { kind: "redirect", matches: [] })
      .then((check) => check.readiness)
      .catch((caught: unknown): GeoReadiness => {
        // Forgotten so a later editor retries. Never an error on screen: this
        // only decides whether to warn, and must not get in the way of a rule.
        requests.delete(targetId);
        return {
          status: "unknown",
          cause: "transient",
          reason:
            caught instanceof Error
              ? caught.message
              : "The check did not answer",
        };
      });
    requests.set(targetId, request);
  }
  return request;
};

/**
 * The target's readiness for country conditions, fetched only once `enabled` —
 * the editor asks when the rule gains a country condition, so a console that
 * never writes one never calls CloudFront. `null` until it answers.
 */
export function useGeoReadiness(
  targetId: string,
  enabled: boolean,
): GeoReadiness | null {
  const [readiness, setReadiness] = useState<GeoReadiness | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let current = true;
    void readinessOf(targetId).then((answer) => {
      if (current) setReadiness(answer);
    });
    return () => {
      current = false;
    };
  }, [targetId, enabled]);

  return enabled ? readiness : null;
}

/** For tests: forgets every answer, as a page load would. */
export const resetGeoReadiness = (): void => {
  requests.clear();
};

/**
 * The behaviors that make a country rewrite unsafe to save: they cache without
 * the country in the cache key, so the page rewritten for one viewer's country
 * is cached and served to everyone. A redirect is only warned about — it is
 * `no-store`, so the same setup makes it miss viewers, never misdirect them.
 * The other failing verdicts leave a rule inert, which is safe too.
 *
 * Empty while the check has not answered or could not read the distribution:
 * the console blocks only what it knows is wrong.
 */
export const unsafeForCountryRewrite = (
  readiness: GeoReadiness | null,
): string[] =>
  readiness?.status === "checked"
    ? readiness.behaviors
        .filter((behavior) => behavior.verdict === "cachedWithoutCountry")
        .map((behavior) => behavior.pathPattern)
    : [];
