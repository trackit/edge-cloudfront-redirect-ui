import type { RuleRepository } from "./dynamodb-repository.js";
import type {
  MatchCondition,
  MatchResult,
  RedirectRule,
  RequestParams,
  RuleKind,
} from "./rule-types.js";
import { MatchType, MatchOperator } from "./rule-types.js";
import { TtlCache } from "./ttl-cache.js";
import { appendQueryStringIfNeeded } from "./lib/append-query-string.js";
import { buildFullUrl } from "./lib/build-full-url.js";
import { buildRegex } from "./lib/build-regex.js";
import { checkAkamaiVariant } from "./lib/check-akamai-variant.js";
import { getMatchSource } from "./lib/get-match-source.js";

const splitPath = (path: string): { pathname: string; search: string } => {
  const [pathname = "", ...rest] = path.split("?");
  return {
    pathname,
    search: rest.length > 0 ? `?${rest.join("?")}` : "",
  };
};

export class RulesService {
  private readonly cache: TtlCache<RedirectRule[]>;

  constructor(
    private readonly repo: RuleRepository,
    cacheTtlMs: number,
  ) {
    this.cache = new TtlCache<RedirectRule[]>(cacheTtlMs);
  }

  clearCache(): void {
    this.cache.clear();
  }

  /** First enabled rule whose conditions all match, in priority order. */
  async match(
    params: RequestParams,
    kind: RuleKind,
  ): Promise<MatchResult | null> {
    const rules = await this.loadRules(params.hostname, kind);

    const matched = rules.find(
      (rule) =>
        this.isEvaluable(rule, params) &&
        rule.matches.every((m) => this.evaluateMatch(m, params)),
    );

    return matched ? this.formatResult(matched, params) : null;
  }

  /**
   * Whether every condition on the rule has something to be tested against.
   *
   * Only the country can be *unknown* rather than merely different: CloudFront
   * adds `CloudFront-Viewer-Country` after the viewer-request event, and a
   * distribution that never asks for it in a cache or origin request policy
   * never sends it at all. Skipping the rule is not a nicety, it is the only
   * safe answer — with an empty source the comparison fails, and `negate` then
   * flips that into a match, so "redirect everyone except France" would fire
   * for France too, and for every other country. Failing to match is a rule
   * that does nothing; matching everything is an outage.
   *
   * Filtered here and not in `loadRules` so the TTL cache stays keyed on host
   * and kind alone, and holds the same rules for every request.
   */
  private isEvaluable(rule: RedirectRule, params: RequestParams): boolean {
    if (params.country) return true;
    return !rule.matches.some((m) => m.matchType === MatchType.COUNTRY);
  }

  private async loadRules(
    hostname: string,
    kind: RuleKind,
  ): Promise<RedirectRule[]> {
    // The partition key is stored lowercase — DNS is case-insensitive while a
    // DynamoDB key is not, so the console API normalizes every host it writes.
    // A viewer is free to send `WWW.Example.com` in the Host header, and looking
    // that up verbatim finds an empty partition: every rule for the site
    // silently stops firing, with nothing in the logs to say why.
    //
    // Only the key is lowered. `params.hostname` keeps the value the viewer
    // actually sent, because a `hostname` match condition may be declared
    // `caseSensitive` and has to see the real thing.
    const key = hostname.toLowerCase();

    // Keyed on the normalized host too, so the two spellings share one entry
    // instead of caching the same rules twice.
    const cacheKey = `${key}:${kind}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) return cached;

    const items = await this.repo.queryByPrefix<RedirectRule>(key, `${kind}#`);

    // DynamoDB already returns ascending sk, but sorting here keeps priority
    // correct for any other repository implementation, and `disabled` rules
    // are dropped before they reach the cache.
    const rules = items
      .filter((rule) => rule.disabled !== true)
      .sort((a, b) => a.sk.localeCompare(b.sk));

    this.cache.set(cacheKey, rules);
    return rules;
  }

  private evaluateMatch(
    match: MatchCondition,
    request: RequestParams,
  ): boolean {
    const { pathname } = splitPath(request.path);
    const valueToTest = getMatchSource(
      match,
      request,
      pathname,
      buildFullUrl(request),
    );
    const caseSensitive = match.caseSensitive ?? false;

    let isMatch = false;

    if (
      match.matchType === MatchType.REGEX ||
      match.matchOperator === MatchOperator.REGEX
    ) {
      try {
        isMatch = buildRegex(match.matchValue, caseSensitive).test(valueToTest);
      } catch {
        // A malformed regex fails just this condition — it must not throw and
        // bypass every other rule for the host. (firstRegexCapture swallows the
        // same error.) A negated bad-regex condition still resolves to `false`
        // here, then flips to `true` below, matching the plain-string path.
        isMatch = false;
      }
    } else {
      const testVal = caseSensitive ? valueToTest : valueToTest.toLowerCase();
      const matchVal = caseSensitive
        ? match.matchValue
        : match.matchValue.toLowerCase();
      // Space-separated alternatives, Akamai-style: any variant may match.
      const variants = matchVal.split(" ").filter((v) => v.length > 0);
      isMatch = variants.some((v) =>
        checkAkamaiVariant(testVal, v, match.matchOperator),
      );
    }

    return match.negate ? !isMatch : isMatch;
  }

  private formatResult(rule: RedirectRule, params: RequestParams): MatchResult {
    const { pathname, search } = splitPath(params.path);

    let targetString =
      rule.type === "erMatchRule"
        ? rule.redirectURL
        : (rule.forwardSettings.pathAndQS ?? pathname);

    const capture = this.firstRegexCapture(rule, params, pathname);
    if (capture) {
      targetString = targetString.replace(
        /\$([1-9]\d*)/g,
        (_, n: string) => capture[parseInt(n, 10)] ?? "",
      );
    }

    targetString = appendQueryStringIfNeeded(targetString, search, rule);

    if (rule.type === "erMatchRule") {
      return {
        type: "redirect",
        statusCode: rule.statusCode,
        redirectURL: targetString,
      };
    }

    const includePath =
      rule.forwardSettings.pathAndQS !== undefined || targetString !== pathname;

    return {
      type: "rewrite",
      forwardSettings: {
        ...(rule.forwardSettings.origin && {
          origin: rule.forwardSettings.origin,
        }),
        ...(includePath && { pathAndQS: targetString }),
      },
      // `appendQueryStringIfNeeded` above decides whether the incoming query
      // string is carried into the target; this is the other half of the same
      // flag — whether it is cleared when it was not. Only an explicit `false`
      // clears it. See MatchResult.
      dropIncomingQueryString:
        rule.forwardSettings.useIncomingQueryString === false,
    };
  }

  /** Capture groups from the rule's first regex condition, for `$1` expansion. */
  private firstRegexCapture(
    rule: RedirectRule,
    params: RequestParams,
    pathname: string,
  ): RegExpExecArray | null {
    const fullUrl = buildFullUrl(params);

    for (const m of rule.matches) {
      const isRegexMode =
        m.matchType === MatchType.REGEX ||
        m.matchOperator === MatchOperator.REGEX;
      if (!isRegexMode) continue;

      const source = getMatchSource(m, params, pathname, fullUrl);
      try {
        const execResult = buildRegex(
          m.matchValue,
          m.caseSensitive ?? false,
        ).exec(source);
        if (execResult) return execResult;
      } catch {
        continue;
      }
    }

    return null;
  }
}
