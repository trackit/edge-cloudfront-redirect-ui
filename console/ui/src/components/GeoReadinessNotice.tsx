import type { BehaviorReadiness, GeoReadiness } from "../api";

interface Props {
  readiness: GeoReadiness | null;
  /** A rewrite is where the cache case turns from a miss into a wrong page. */
  kind: "redirect" | "rewrite";
}

/** What each failing verdict means for the rule, in the editor's words. */
const PROBLEM: Record<Exclude<BehaviorReadiness["verdict"], "ok">, string> = {
  cachedWithoutCountry:
    "caches without CloudFront-Viewer-Country in its cache key, so a copy cached for one country is served to the next viewer and this rule misses them",
  countryNotForwarded:
    "does not ask CloudFront for the country, so this rule is skipped",
  noOriginRequest:
    "does not run the function at origin-request, where country conditions are evaluated",
  // Never listed: filtered out below, since no rule runs there.
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
 * Warns, under a rule's conditions, when its distribution cannot serve a
 * country condition reliably. The edge cannot say so itself: a request served
 * from cache never reaches it.
 *
 * Silent while the check runs and when it passes. When the API could not read
 * the distribution it says so quietly, because "not checked" is not "fine".
 */
export default function GeoReadinessNotice({ readiness, kind }: Props) {
  if (readiness === null) return null;

  if (readiness.status === "unknown") {
    return (
      <p className="hint" role="status">
        Could not check this distribution&apos;s cache settings:{" "}
        {readiness.reason}.
      </p>
    );
  }

  const failing = readiness.behaviors.filter(
    (b) => b.verdict !== "ok" && b.verdict !== "notOurs",
  );
  if (failing.length === 0) return null;
  const blocks =
    kind === "rewrite" &&
    failing.some((b) => b.verdict === "cachedWithoutCountry");
  return (
    <div className="callout is-warn geo-readiness" role="status">
      <div>
        <strong>
          Distribution {readiness.distributionId} is not set up for country
          conditions.
        </strong>
        <ul>
          {failing.map((behavior) => (
            <li key={behavior.pathPattern}>
              {label(behavior.pathPattern)}{" "}
              {kind === "rewrite" && behavior.verdict === "cachedWithoutCountry"
                ? REWRITE_CACHED
                : PROBLEM[behavior.verdict as keyof typeof PROBLEM]}
              .
            </li>
          ))}
        </ul>
        {blocks && (
          <>
            <strong>
              This rewrite cannot be saved until that is fixed.
            </strong>{" "}
          </>
        )}
        Fix: add <code>CloudFront-Viewer-Country</code> to the cache policy of a
        behavior that caches, or serve these paths from a behavior that does not
        cache and forwards it in its origin request policy.
      </div>
    </div>
  );
}
