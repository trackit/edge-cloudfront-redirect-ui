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

    const matched = rules.find((rule) =>
      rule.matches.every((m) => this.evaluateMatch(m, params)),
    );

    return matched ? this.formatResult(matched, params) : null;
  }

  private async loadRules(
    hostname: string,
    kind: RuleKind,
  ): Promise<RedirectRule[]> {
    const cacheKey = `${hostname}:${kind}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) return cached;

    const items = await this.repo.queryByPrefix<RedirectRule>(
      hostname,
      `${kind}#`,
    );

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
