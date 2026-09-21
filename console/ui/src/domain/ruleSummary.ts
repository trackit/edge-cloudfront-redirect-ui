import { isRedirect, narrowForwardSettings } from "../api";
import type { MatchCondition, Rule } from "../api";

/**
 * The one-line renderings a rule list needs. Kept out of the components so the
 * wording of a rule is decided in one place — the list, the editor's preview and
 * any future confirmation dialog should all describe a rule the same way.
 */

/** `path equals /old`, or `header:x-env not contains staging`. */
export const describeMatch = (match: MatchCondition): string => {
  const subject =
    match.matchType === "header"
      ? `header:${match.headerName ?? "?"}`
      : match.matchType;
  const negated = match.negate === true ? "not " : "";
  return `${subject} ${negated}${match.matchOperator} ${match.matchValue}`;
};

/** All of a rule's conditions on one line, or the fact that it has none. */
export const describeMatches = (rule: Rule): string =>
  rule.matches.length === 0
    ? "matches every request"
    : rule.matches.map(describeMatch).join("  ·  ");

/**
 * The "from" side: what the rule reacts to.
 *
 * The first condition's value, because that is what a reader scans for. It is a
 * summary, not the truth — `describeMatches` carries the rest, and a rule with
 * no conditions matches everything.
 */
export const ruleFrom = (rule: Rule): string =>
  rule.matches[0]?.matchValue ?? "any request";

/**
 * The "to" side: what the rule does.
 *
 * A rewrite may change the origin, the path, or both, so the origin is named
 * first when there is one — it is the bigger change — and the path stands alone
 * otherwise. A rewrite that changes neither is possible to store through the
 * schema's `anyOf` only by accident, and says so rather than rendering blank.
 */
export const ruleTo = (rule: Rule): string => {
  if (isRedirect(rule)) return rule.redirectURL;

  const { origin, pathAndQS } = narrowForwardSettings(rule);
  if (origin === undefined) return pathAndQS ?? "no change";

  const target =
    origin.s3 !== undefined
      ? `S3 · ${origin.s3.domainName}`
      : origin.custom !== undefined
        ? `${origin.custom.protocol} · ${origin.custom.domainName}`
        : "origin";

  return pathAndQS === undefined || pathAndQS === ""
    ? target
    : `${target}${pathAndQS}`;
};

/** The badge text for a rule's kind, including the status code for a redirect. */
export const ruleKindLabel = (rule: Rule): string =>
  isRedirect(rule) ? `${rule.statusCode} redirect` : "rewrite";
