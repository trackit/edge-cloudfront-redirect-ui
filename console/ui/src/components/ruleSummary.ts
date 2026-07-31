import type { MatchCondition, Rule } from '../types';
import { isRedirect } from '../types';

/** Human-readable one-liner for a match condition, e.g. `path equals /old`. */
export function describeMatch(m: MatchCondition): string {
  const label = m.matchType === 'header' ? `header:${m.headerName}` : m.matchType;
  const op = m.matchOperator;
  const neg = m.negate ? 'not ' : '';
  return `${label} ${neg}${op} ${m.matchValue}`;
}

/** Short "from" side of a rule summary (what it matches on). */
export function ruleFrom(rule: Rule): string {
  const first = rule.matches[0];
  if (!first) return 'any request';
  return first.matchValue;
}

/** Short "to" side of a rule summary (what it does). */
export function ruleTo(rule: Rule): string {
  if (isRedirect(rule)) return rule.redirectURL;
  const o = rule.forwardSettings.origin;
  if (o?.s3) return `S3 · ${o.s3.domainName}`;
  if (o?.custom) return `${o.custom.protocol} · ${o.custom.domainName}`;
  return rule.forwardSettings.pathAndQS ?? 'rewritten path';
}
