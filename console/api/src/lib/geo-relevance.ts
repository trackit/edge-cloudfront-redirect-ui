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
   * True when the rule is ambiguous only because a path condition ignores
   * case: CloudFront's path patterns do not, so `/GEO/FR` can land on another
   * behavior than `/geo/fr`. Turning on Match case would pin it.
   */
  matchCaseWouldPin: boolean;
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

/** A leading `/` is optional in a CloudFront pattern: `fr/*` is `/fr/*`. */
const anchor = (pattern: string): string =>
  pattern.startsWith("/") || pattern.startsWith("*") ? pattern : `/${pattern}`;

/** One character of a glob: a literal, `?` (any one), or `*` (any run). */
type Token = { star: true } | { star: false; any: boolean; ch: string };

/** The edge's dialect has `*` only — its `?` is a literal. */
const variantTokens = (variant: string): Token[] =>
  variant
    .split("")
    .map((ch) =>
      ch === "*" ? { star: true } : { star: false, any: false, ch },
    );

const patternTokens = (pattern: string): Token[] =>
  anchor(pattern)
    .split("")
    .map((ch) =>
      ch === "*" ? { star: true } : { star: false, any: ch === "?", ch },
    );

/**
 * CloudFront's path pattern syntax: `*` any run, `?` one character,
 * case-sensitive. The leading `/` is optional in a pattern — `fr/*` and
 * `/fr/*` are the same behavior — so one is added when missing.
 */
export const globMatches = (pattern: string, path: string): boolean =>
  overlaps(
    path.split("").map((ch) => ({ star: false, any: false, ch })),
    patternTokens(pattern),
    false,
  );

const hasCase = (ch: string): boolean => ch.toLowerCase() !== ch.toUpperCase();

/**
 * Whether some path matches both the rule's variant and the behavior's
 * pattern. A variant compared without case is lowercased by the edge, so it
 * matches every casing of its paths: a pattern character then meets it on its
 * lowercase form.
 */
const overlaps = (
  variant: Token[],
  pattern: Token[],
  ignoreCase: boolean,
): boolean => {
  const same = (a: string, b: string): boolean =>
    ignoreCase ? a.toLowerCase() === b.toLowerCase() : a === b;
  const seen = new Set<number>();
  const visit = (i: number, j: number): boolean => {
    const key = i * (pattern.length + 1) + j;
    if (seen.has(key)) return false;
    seen.add(key);
    const v = variant[i];
    const p = pattern[j];
    if (v === undefined && p === undefined) return true;
    if (v?.star === true && visit(i + 1, j)) return true;
    if (p?.star === true && visit(i, j + 1)) return true;
    // A star takes one character the other side spells out.
    if (v?.star === true && p !== undefined && !p.star && visit(i, j + 1)) {
      return true;
    }
    if (p?.star === true && v !== undefined && !v.star && visit(i + 1, j)) {
      return true;
    }
    if (v === undefined || p === undefined || v.star || p.star) return false;
    return (p.any || same(v.ch, p.ch)) && visit(i + 1, j + 1);
  };
  return visit(0, 0);
};

/**
 * Whether every path the variant matches is caught by the pattern, so no
 * later behavior can serve it. Only the shapes that settle it cheaply are
 * recognized — a pattern that is the variant itself, or a literal prefix and
 * one trailing `*` — and anything else counts as not covered, which only
 * keeps later behaviors among the candidates.
 */
const covers = (
  pattern: Token[],
  variant: Token[],
  ignoreCase: boolean,
): boolean => {
  // Under ignoreCase a cased character stands for both its casings, which one
  // literal in a case-sensitive pattern cannot catch.
  const literalSame = (p: Token | undefined, v: Token | undefined): boolean =>
    p !== undefined &&
    v !== undefined &&
    !p.star &&
    !v.star &&
    (p.any || (p.ch === v.ch && !(ignoreCase && hasCase(v.ch))));

  const last = pattern.length - 1;
  const trailingStar =
    pattern[last]?.star === true &&
    pattern.slice(0, last).every((t) => !t.star);
  if (trailingStar) {
    const prefix = pattern.slice(0, last);
    return prefix.every((p, k) => literalSame(p, variant[k]));
  }
  return (
    pattern.every((t) => !t.star) &&
    pattern.length === variant.length &&
    pattern.every((p, k) => literalSame(p, variant[k]))
  );
};

/** The behaviors one exact-path variant can land on, in CloudFront's order. */
const servingVariant = (
  variant: string,
  ignoreCase: boolean,
  behaviors: BehaviorReadiness[],
): BehaviorReadiness[] => {
  // CloudFront matches patterns on the path alone. resolve() has ruled out a
  // `*` that could reach past the `?`, so the text before it is the path.
  const path = variant.split("?")[0] ?? "";
  const tokens = variantTokens(ignoreCase ? path.toLowerCase() : path);
  const out: BehaviorReadiness[] = [];
  for (const behavior of behaviors) {
    const pattern = patternTokens(behavior.pathPattern);
    if (!overlaps(tokens, pattern, ignoreCase)) continue;
    out.push(behavior);
    if (covers(pattern, tokens, ignoreCase)) break;
  }
  return out;
};

const isExactPath = (match: MatchLike): boolean =>
  match.matchType === "path" &&
  match.matchOperator === "equals" &&
  match.negate !== true;

const resolve = (
  exact: MatchLike[],
  behaviors: BehaviorReadiness[],
  forceCaseSensitive: boolean,
): { relevant: BehaviorReadiness[]; ambiguous: boolean } => {
  const served = new Set<BehaviorReadiness>();
  let ambiguous = false;
  for (const match of exact) {
    const ignoreCase = !forceCaseSensitive && match.caseSensitive !== true;
    // A `?` anywhere in the value makes the edge test every alternative
    // against path and query together (get-match-source.ts). A `*` before an
    // alternative's first `?` can then run on into the query string, so the
    // path CloudFront routes on is no longer the text before that `?`.
    const seesQuery = match.matchValue.includes("?");
    // The edge reads a match value the Akamai way: space-separated
    // alternatives, any of which may match (rules-service.ts,
    // check-akamai-variant.ts).
    for (const variant of match.matchValue.split(" ")) {
      if (variant.length === 0) continue;
      if (seesQuery && (variant.split("?")[0] ?? "").includes("*")) {
        return {
          relevant: behaviors.filter((b) => b.verdict !== "notOurs"),
          ambiguous: true,
        };
      }
      const landing = servingVariant(variant, ignoreCase, behaviors);
      if (landing.length > 1) ambiguous = true;
      for (const b of landing) served.add(b);
    }
  }
  // CloudFront's order, so the editor lists them as the distribution does.
  const relevant = behaviors.filter((b) => served.has(b));
  // Among several candidates a behavior that never runs the function says
  // nothing about the rule; one the rule is pinned to says it never runs.
  return {
    relevant: ambiguous
      ? relevant.filter((b) => b.verdict !== "notOurs")
      : relevant,
    ambiguous,
  };
};

/**
 * The behaviors that can serve a rule. An `equals` path condition narrows it
 * to the behaviors whose pattern can catch that path — each of its
 * space-separated alternatives, `*` wildcards included — in CloudFront's
 * order, stopping at the first that catches all of it. Compared without case,
 * which CloudFront patterns are not, a path reaches the behaviors serving any
 * of its casings. Anything looser — contains, regex, negated, or no path
 * condition — can reach every behavior running our function.
 *
 * A path condition's `caseSensitive` defaults to false at the edge
 * (infra/lambda/src/rules-service.ts), so only an explicit `true` pins it to
 * one casing.
 */
export const behaviorsServing = (
  matches: MatchLike[],
  behaviors: BehaviorReadiness[],
): {
  relevant: BehaviorReadiness[];
  ambiguous: boolean;
  matchCaseWouldPin: boolean;
} => {
  const exact = matches.filter(isExactPath);
  if (exact.length === 0) {
    return {
      relevant: behaviors.filter((b) => b.verdict !== "notOurs"),
      ambiguous: true,
      matchCaseWouldPin: false,
    };
  }
  const result = resolve(exact, behaviors, false);
  const matchCaseWouldPin =
    result.ambiguous &&
    exact.some((match) => match.caseSensitive !== true) &&
    !resolve(exact, behaviors, true).ambiguous;
  return { ...result, matchCaseWouldPin };
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
    return {
      outcome: "ok",
      relevant: [],
      ambiguous: false,
      matchCaseWouldPin: false,
      dropped: [],
    };
  }
  if (readiness.status === "unknown") {
    return {
      outcome: kind === "rewrite" ? "unverifiable" : "warn",
      relevant: [],
      ambiguous: false,
      matchCaseWouldPin: false,
      dropped: [],
    };
  }

  const { relevant, ambiguous, matchCaseWouldPin } = behaviorsServing(
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
  return { outcome, relevant, ambiguous, matchCaseWouldPin, dropped };
};
