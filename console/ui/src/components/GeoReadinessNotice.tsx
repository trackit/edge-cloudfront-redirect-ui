import type { BehaviorReadiness, GeoCheck } from "../api";
import { describeDropped } from "../domain/geoReadiness";

interface Props {
  /** The API's reading and its decision for the rule being edited. */
  check: GeoCheck | null;
  /** A rewrite is where the cache case turns from a miss into a wrong page. */
  kind: "redirect" | "rewrite";
  /** Asks the API for a fresh reading — after fixing the distribution, say. */
  onRecheck?: () => void;
  rechecking?: boolean;
}

/** What each failing verdict means for the rule, in the editor's words. */
const PROBLEM: Record<Exclude<BehaviorReadiness["verdict"], "ok">, string> = {
  cachedWithoutCountry:
    "caches without CloudFront-Viewer-Country in its cache key, so a copy cached for one country is served to the next viewer and this rule misses them",
  countryNotForwarded:
    "does not ask CloudFront for the country, so this rule is skipped",
  noOriginRequest:
    "does not run the function at origin-request, where country conditions are evaluated",
  notOurs: "does not run the redirect function, so this rule never runs there",
  viewerHostMissing:
    "does not pass the viewer's hostname to origin-request (X-EdgeRoute-Viewer-Host), so this rule never matches",
  cachedByOriginHeaders:
    "only caches when the origin asks for it in Cache-Control; if it does, a copy cached for one country is served to the next viewer",
};

/** The same cache case, as it lands on a rewrite. */
const REWRITE_CACHED =
  "caches without CloudFront-Viewer-Country in its cache key, so the page rewritten for one country would be cached and served to everyone";

const label = (pattern: string): string =>
  pattern === "*" ? "The default behavior" : `Behavior ${pattern}`;

/**
 * Warns, under a rule's conditions, when the behaviors that can serve it
 * cannot serve a country condition reliably. The edge cannot say so itself: a
 * request served from cache never reaches it.
 *
 * Only the behaviors serving this rule are named — the API resolves them from
 * the rule's path — so the recommended setup (an uncached geo behavior beside
 * a cached default) is silent for a rule on the geo paths.
 *
 * Silent while the check runs and when it passes. When the API could not read
 * the distribution it says so quietly, because "not checked" is not "fine".
 */
export default function GeoReadinessNotice({
  check,
  kind,
  onRecheck,
  rechecking = false,
}: Props) {
  if (check === null) return null;
  const { readiness, decision } = check;

  const recheck = onRecheck && (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      onClick={onRecheck}
      disabled={rechecking}
    >
      Re-check
    </button>
  );

  if (readiness.status === "unknown") {
    return (
      <p className="hint" role="status">
        Could not check this distribution&apos;s cache settings:{" "}
        {readiness.reason}. {recheck}
      </p>
    );
  }

  const unnamed = !readiness.functionIdentified && (
    <p className="hint" role="status">
      Redirect function not set on this distribution: every behavior running a
      Lambda@Edge function is checked. Set it in the distribution&apos;s
      settings to leave out the ones running someone else&apos;s.
    </p>
  );

  const dropped = decision.dropped ?? [];
  if (dropped.length > 0) {
    return (
      <div className="callout is-warn geo-readiness" role="status">
        <div>
          <strong>This rewrite would fire for every viewer.</strong>{" "}
          {describeDropped(dropped)}: CloudFront drops it before origin-request,
          so the negated condition reads it as absent.{" "}
          <strong>It cannot be saved until that is fixed.</strong> Fix: add it
          to the origin request policy of that behavior. {recheck}
        </div>
      </div>
    );
  }

  const failing = decision.relevant.filter((b) => b.verdict !== "ok");
  if (failing.length === 0) return unnamed || null;

  return (
    <>
      <div className="callout is-warn geo-readiness" role="status">
        <div>
          <strong>
            Distribution {readiness.distributionId} is not set up for country
            conditions.
          </strong>
          {decision.ambiguous && (
            <p>
              This rule can be served by several behaviors: its path condition
              is not an exact, case-sensitive path.
            </p>
          )}
          <ul>
            {failing.map((behavior) => (
              <li key={behavior.pathPattern}>
                {label(behavior.pathPattern)}{" "}
                {kind === "rewrite" &&
                behavior.verdict === "cachedWithoutCountry"
                  ? REWRITE_CACHED
                  : PROBLEM[behavior.verdict as keyof typeof PROBLEM]}
                .
              </li>
            ))}
          </ul>
          {decision.outcome === "blocked" && (
            <>
              <strong>
                This rewrite cannot be saved until that is fixed.
              </strong>{" "}
            </>
          )}
          Fix: add <code>CloudFront-Viewer-Country</code> to the cache policy of
          a behavior that caches, or serve these paths from a behavior that does
          not cache and forwards it in its origin request policy. {recheck}
        </div>
      </div>
      {unnamed}
    </>
  );
}
