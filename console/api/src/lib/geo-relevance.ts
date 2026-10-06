import type { BehaviorReadiness, GeoReadiness } from "./geo-readiness.js";

/**
 * Which of a distribution's behaviors can serve a rule, and what that means for
 * saving it. One implementation for both the editor's check and the write
 * guard, so the two can never disagree about the same rule.
 */

export interface MatchLike {
  matchType: string;
  matchOperator: string;
  matchValue: string;
  negate?: boolean;
  caseSensitive?: boolean;
}

export type RuleKind = "redirect" | "rewrite";

/**
 * - `ok`: nothing to say.
 * - `warn`: the rule may misfire or never run; saving is still fine.
 * - `blocked`: a rewrite that would be cached and served to every country.
 * - `unverifiable`: a rewrite on a distribution that could not be read.
 */
export type GeoOutcome = "ok" | "warn" | "blocked" | "unverifiable";

export interface GeoDecision {
  outcome: GeoOutcome;
  /** The behaviors that can serve the rule, in CloudFront's order. */
  relevant: BehaviorReadiness[];
  /** True when the rule's path does not pin it to one behavior. */
  ambiguous: boolean;
}

export const readsCountry = (matches: MatchLike[]): boolean =>
  matches.some((match) => match.matchType === "country");

const REGEX_SPECIAL = /[.+^${}()|[\]\\/]/g;

/**
 * CloudFront's path pattern syntax: `*` any run, `?` one character,
 * case-sensitive. The leading `/` is optional in a pattern — `fr/*` and
 * `/fr/*` are the same behavior — so one is added when missing.
 */
export const globMatches = (pattern: string, path: string): boolean => {
  const anchored =
    pattern.startsWith("/") || pattern.startsWith("*")
      ? pattern
      : `/${pattern}`;
  const source = anchored
    .split("")
    .map((ch) =>
      ch === "*" ? ".*" : ch === "?" ? "." : ch.replace(REGEX_SPECIAL, "\\$&"),
    )
    .join("");
  return new RegExp(`^${source}$`).test(path);
};

/**
 * An exact path pins the rule to one behavior: the first whose pattern matches,
 * else the default. Anything looser — contains, regex, negated, or compared
 * case-insensitively, which CloudFront patterns are not — can reach several, so
 * every behavior running our function counts.
 *
 * A path condition's `caseSensitive` defaults to false at the edge
 * (infra/lambda/src/rules-service.ts), so only an explicit `true` pins it.
 * The query string is cut off: CloudFront matches patterns on the path alone.
 */
export const behaviorsServing = (
  matches: MatchLike[],
  behaviors: BehaviorReadiness[],
): { relevant: BehaviorReadiness[]; ambiguous: boolean } => {
  const exact = matches.filter(
    (match) =>
      match.matchType === "path" &&
      match.matchOperator === "equals" &&
      match.negate !== true &&
      match.caseSensitive === true,
  );
  if (exact.length === 0) {
    return {
      relevant: behaviors.filter((b) => b.verdict !== "notOurs"),
      ambiguous: true,
    };
  }

  // The edge reads a match value the Akamai way: space-separated alternatives,
  // any of which may match, each with `*` as a wildcard (rules-service.ts,
  // check-akamai-variant.ts). Every alternative is resolved on its own, and one
  // with a wildcard can reach any behavior.
  const paths = exact.flatMap((match) =>
    match.matchValue.split(" ").filter((variant) => variant.length > 0),
  );
  if (paths.some((variant) => variant.includes("*"))) {
    return {
      relevant: behaviors.filter((b) => b.verdict !== "notOurs"),
      ambiguous: true,
    };
  }

  const served = new Map<string, BehaviorReadiness>();
  for (const variant of paths) {
    const path = variant.split("?")[0] ?? "";
    const behavior = behaviors.find((b) => globMatches(b.pathPattern, path));
    if (behavior) served.set(behavior.pathPattern, behavior);
  }
  return { relevant: [...served.values()], ambiguous: false };
};

/**
 * What saving the rule should do. Only a rewrite is ever blocked: a redirect is
 * `no-store`, so the same setup makes it miss viewers, never misdirect them.
 * An ambiguous rewrite is blocked as soon as one candidate behavior would cache
 * it for everyone — the rule cannot prove it avoids that one.
 */
export const geoDecision = (
  kind: RuleKind,
  matches: MatchLike[],
  readiness: GeoReadiness,
): GeoDecision => {
  if (!readsCountry(matches)) {
    return { outcome: "ok", relevant: [], ambiguous: false };
  }
  if (readiness.status === "unknown") {
    return {
      outcome: kind === "rewrite" ? "unverifiable" : "warn",
      relevant: [],
      ambiguous: false,
    };
  }

  const { relevant, ambiguous } = behaviorsServing(
    matches,
    readiness.behaviors,
  );
  const outcome: GeoOutcome =
    kind === "rewrite" &&
    relevant.some((b) => b.verdict === "cachedWithoutCountry")
      ? "blocked"
      : relevant.some((b) => b.verdict !== "ok")
        ? "warn"
        : "ok";
  return { outcome, relevant, ambiguous };
};
