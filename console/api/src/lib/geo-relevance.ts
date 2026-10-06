import type {
  BehaviorReadiness,
  GeoReadiness,
  Passed,
} from "./geo-readiness.js";

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
  headerName?: string;
}

export type RuleKind = "redirect" | "rewrite";

/**
 * - `ok`: nothing to say.
 * - `warn`: the rule may misfire or never run; saving is still fine.
 * - `blocked`: a rewrite that would be cached and served to every country, or
 *   one negating a header or cookie its behavior drops — it then matches
 *   every viewer.
 * - `unverifiable`: a rewrite on a distribution that could not be read.
 */
export type GeoOutcome = "ok" | "warn" | "blocked" | "unverifiable";

export interface GeoDecision {
  outcome: GeoOutcome;
  /** The behaviors that can serve the rule, in CloudFront's order. */
  relevant: BehaviorReadiness[];
  /** True when the rule's path does not pin it to one behavior. */
  ambiguous: boolean;
  /**
   * Negated header and cookie conditions a serving behavior does not send on
   * to origin-request. `name` is null for a cookie whose name the value does
   * not say (a regex or a wildcard), which needs every cookie sent on.
   */
  dropped: DroppedCondition[];
}

export interface DroppedCondition {
  pathPattern: string;
  matchType: "header" | "cookie";
  name: string | null;
}

export const readsCountry = (matches: MatchLike[]): boolean =>
  matches.some((match) => match.matchType === "country");

/**
 * The edge's own comparison (rules-service.ts evaluateMatch,
 * check-akamai-variant.ts), run against an empty value: what a condition does
 * with a header or cookie that never arrived.
 */
const matchesEmpty = (match: MatchLike): boolean => {
  const caseSensitive = match.caseSensitive ?? false;
  if (match.matchType === "regex" || match.matchOperator === "regex") {
    try {
      return new RegExp(
        match.matchValue.replace(/\\\//g, "/"),
        caseSensitive ? "" : "i",
      ).test("");
    } catch {
      return false;
    }
  }
  const variants = match.matchValue.split(" ").filter((v) => v.length > 0);
  // A variant matches "" only through a wildcard: "*" alone, say.
  const variantMatches = (variant: string): boolean =>
    variant.includes("*") &&
    new RegExp(
      `^${variant.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`,
    ).test("");
  return match.matchOperator === "notEquals"
    ? !variants.some(variantMatches)
    : variants.some(variantMatches);
};

/**
 * Header and cookie conditions that hold when the value is absent. At
 * origin-request a header or cookie the behavior's policies do not send on is
 * absent for every viewer — so such a condition holds for everyone. Judged on
 * what the condition does with "", not on `negate` alone: `^$` or `*` hold
 * too, and `negate` on `notEquals` cancels out.
 */
export const negatedReads = (matches: MatchLike[]): MatchLike[] =>
  matches.filter(
    (match) =>
      (match.matchType === "header" || match.matchType === "cookie") &&
      (match.negate === true ? !matchesEmpty(match) : matchesEmpty(match)),
  );

/**
 * The cookies a cookie condition is about. The edge tests it against the whole
 * Cookie header, so the name is read off the value — `beta=1` is about `beta`.
 * `null` when the value does not say: a regex, a wildcard, or a bare word
 * (`contains premium` can be any cookie's value), which need every cookie.
 */
const cookieNames = (match: MatchLike): string[] | null => {
  if (match.matchOperator === "regex") return null;
  const names = match.matchValue
    .split(" ")
    .filter((variant) => variant.length > 0)
    .map((variant) =>
      variant.includes("*") || !variant.includes("=")
        ? ""
        : (variant.split("=")[0] ?? ""),
    );
  return names.length === 0 || names.includes("") ? null : names;
};

/**
 * Whether a name gets through one of the policies. CloudFront adds the
 * `CloudFront-*` headers itself, and "every viewer header" does not include
 * them: only a policy naming one sends it on.
 */
const reaches = (
  passed: Passed[],
  name: string,
  caseInsensitive: boolean,
  header: boolean,
): boolean => {
  const same = (a: string): boolean =>
    caseInsensitive ? a.toLowerCase() === name.toLowerCase() : a === name;
  const cloudFrontOwn = header && name.toLowerCase().startsWith("cloudfront-");
  return passed.some((p) =>
    p.all && !cloudFrontOwn ? !p.except.some(same) : p.names.some(same),
  );
};

/** Whether every cookie reaches origin-request, for a name the value does not say. */
const everyCookie = (passed: Passed[]): boolean =>
  passed.some((p) => p.all && p.except.length === 0);

const droppedOn = (
  behavior: BehaviorReadiness,
  conditions: MatchLike[],
): DroppedCondition[] => {
  const forwards = behavior.forwards;
  // No rule runs on a behavior without one: notOurs, no origin-request, or a
  // viewer host that never arrives.
  if (forwards === undefined) return [];
  const out: DroppedCondition[] = [];
  for (const match of conditions) {
    if (match.matchType === "header") {
      const name = match.headerName ?? "";
      if (!reaches(forwards.headers, name, true, true)) {
        out.push({
          pathPattern: behavior.pathPattern,
          matchType: "header",
          name,
        });
      }
      continue;
    }
    const names = cookieNames(match);
    if (names === null) {
      if (!everyCookie(forwards.cookies)) {
        out.push({
          pathPattern: behavior.pathPattern,
          matchType: "cookie",
          name: null,
        });
      }
      continue;
    }
    for (const name of names) {
      if (
        !reaches(forwards.cookies, name, match.caseSensitive !== true, false)
      ) {
        out.push({
          pathPattern: behavior.pathPattern,
          matchType: "cookie",
          name,
        });
      }
    }
  }
  return out;
};

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
  const country = readsCountry(matches);
  // Only a rewrite: a redirect without a country runs at viewer-request, where
  // every header and cookie is still there, and one with a country cannot
  // carry header or cookie conditions at all (the schema refuses them).
  const negations = kind === "rewrite" ? negatedReads(matches) : [];
  if (!country && negations.length === 0) {
    return { outcome: "ok", relevant: [], ambiguous: false, dropped: [] };
  }
  if (readiness.status === "unknown") {
    return {
      outcome: kind === "rewrite" ? "unverifiable" : "warn",
      relevant: [],
      ambiguous: false,
      dropped: [],
    };
  }

  const { relevant, ambiguous } = behaviorsServing(
    matches,
    readiness.behaviors,
  );
  const dropped = relevant.flatMap((behavior) =>
    droppedOn(behavior, negations),
  );
  const geo: GeoOutcome = !country
    ? "ok"
    : kind === "rewrite" &&
        relevant.some((b) => b.verdict === "cachedWithoutCountry")
      ? "blocked"
      : relevant.some((b) => b.verdict !== "ok")
        ? "warn"
        : "ok";
  const outcome: GeoOutcome = dropped.length > 0 ? "blocked" : geo;
  return { outcome, relevant, ambiguous, dropped };
};
