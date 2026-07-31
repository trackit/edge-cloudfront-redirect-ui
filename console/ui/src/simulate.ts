import type { MatchCondition, RedirectRule, Rule, RewriteRule } from './types';
import { isRedirect, priorityOf } from './types';

/* In-browser rule evaluator. Mirrors how the Lambda@Edge would evaluate rules:
   - only rules for the requested host (DynamoDB Query by pk = host)
   - disabled rules are skipped
   - rules are checked in priority order (lower number first)
   - within a phase, the first rule whose conditions ALL pass wins
   - viewer-request → redirects; if none, origin-request → rewrites
   This is a faithful *approximation* for understanding rule behaviour, not the
   real edge runtime. */

export interface TestRequest {
  host: string;
  path: string; // may include ?query — split internally
  protocol: 'http' | 'https';
  headerName?: string;
  headerValue?: string;
}

export interface ConditionTrace {
  text: string;
  passed: boolean;
}
export interface RuleTrace {
  rule: Rule;
  matched: boolean;
  skipped: 'disabled' | null;
  conditions: ConditionTrace[];
}

export interface SimResult {
  outcome: 'redirect' | 'rewrite' | 'passthrough';
  matchedRule?: Rule;
  redirect?: { statusCode: 301 | 302; location: string };
  rewrite?: { originLabel: string; pathAndQS: string };
  trace: RuleTrace[];
}

function splitPath(input: string): { path: string; query: string } {
  const i = input.indexOf('?');
  if (i === -1) return { path: input || '/', query: '' };
  return { path: input.slice(0, i) || '/', query: input.slice(i + 1) };
}

/** The request-side value a condition compares against. */
function valueFor(m: MatchCondition, req: TestRequest, path: string): string {
  switch (m.matchType) {
    case 'path':
    case 'regex':
      return path;
    case 'hostname':
      return req.host;
    case 'protocol':
      return req.protocol;
    case 'header':
      return m.headerName &&
        req.headerName &&
        m.headerName.toLowerCase() === req.headerName.toLowerCase()
        ? (req.headerValue ?? '')
        : '';
    case 'cookie':
      return '';
    default:
      return '';
  }
}

function applyOperator(m: MatchCondition, value: string): boolean {
  const cs = m.caseSensitive ?? false;
  const a = cs ? value : value.toLowerCase();
  const b = cs ? m.matchValue : m.matchValue.toLowerCase();
  switch (m.matchOperator) {
    case 'equals':
      return a === b;
    case 'contains':
      return a.includes(b);
    case 'regex':
      try {
        return new RegExp(m.matchValue, cs ? '' : 'i').test(value);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

function evalCondition(
  m: MatchCondition,
  req: TestRequest,
  path: string,
): { passed: boolean; text: string } {
  const value = valueFor(m, req, path);
  let passed = applyOperator(m, value);
  if (m.negate) passed = !passed;
  const label = m.matchType === 'header' ? `header:${m.headerName}` : m.matchType;
  const text = `${label} ${m.negate ? 'not ' : ''}${m.matchOperator} "${m.matchValue}"`;
  return { passed, text };
}

function redirectLocation(rule: RedirectRule, query: string): string {
  let loc = rule.redirectURL;
  if (rule.useIncomingQueryString && query) {
    loc += (loc.includes('?') ? '&' : '?') + query;
  }
  return loc;
}

function rewriteOriginLabel(rule: RewriteRule): string {
  const o = rule.forwardSettings.origin;
  if (o?.s3) return `S3 · ${o.s3.domainName}`;
  if (o?.custom) return `${o.custom.protocol} · ${o.custom.domainName}`;
  return 'same origin';
}

export function simulate(allRules: Rule[], req: TestRequest): SimResult {
  const { path, query } = splitPath(req.path);
  const trace: RuleTrace[] = [];

  // DynamoDB Query(pk = host): only this host's rules, ordered by priority.
  const hostRules = allRules
    .filter((r) => r.pk === req.host)
    .sort((a, b) => priorityOf(a.sk) - priorityOf(b.sk));

  const redirects = hostRules.filter(isRedirect);
  const rewrites = hostRules.filter((r): r is RewriteRule => !isRedirect(r));

  // viewer-request phase: redirects
  for (const rule of redirects) {
    if (rule.disabled) {
      trace.push({ rule, matched: false, skipped: 'disabled', conditions: [] });
      continue;
    }
    const conditions = rule.matches.map((m) => evalCondition(m, req, path));
    const matched = conditions.every((c) => c.passed);
    trace.push({ rule, matched, skipped: null, conditions });
    if (matched) {
      return {
        outcome: 'redirect',
        matchedRule: rule,
        redirect: {
          statusCode: rule.statusCode,
          location: redirectLocation(rule, query),
        },
        trace,
      };
    }
  }

  // origin-request phase: rewrites
  for (const rule of rewrites) {
    if (rule.disabled) {
      trace.push({ rule, matched: false, skipped: 'disabled', conditions: [] });
      continue;
    }
    const conditions = rule.matches.map((m) => evalCondition(m, req, path));
    const matched = conditions.every((c) => c.passed);
    trace.push({ rule, matched, skipped: null, conditions });
    if (matched) {
      return {
        outcome: 'rewrite',
        matchedRule: rule,
        rewrite: {
          originLabel: rewriteOriginLabel(rule),
          pathAndQS: rule.forwardSettings.pathAndQS || path,
        },
        trace,
      };
    }
  }

  return { outcome: 'passthrough', trace };
}
