import type {
  MatchCondition,
  MatchType,
  RequestParams,
} from "../rule-types.js";
import { MatchType as MatchTypeValues, MatchOperator } from "../rule-types.js";
import { isFullUrlRegex } from "./is-full-url-regex.js";

/**
 * Whether a match value names the query string.
 *
 * Outside regex mode a `?` is only ever literal, so it can only mean the query.
 * Inside it, `?` is mostly syntax — a quantifier (`/?`, `.+?`), or the opener of
 * `(?:`, `(?=`, `(?<name>` — and only an escaped `\?` or a `?` inside a character
 * class is the character itself. Treating the syntax as a mention sent patterns
 * like `^/products/?$` to path + query, where their `$` anchor then failed on
 * any request that had one (CF-43).
 */
const mentionsQueryString = (value: string, isRegexMode: boolean): boolean => {
  if (!isRegexMode) return value.includes("?");
  // An odd run of backslashes before the `?` escapes it; an even run escapes
  // itself and leaves the `?` a quantifier.
  if (/(?:^|[^\\])(?:\\\\)*\\\?/.test(value)) return true;
  return /\[[^\]]*\?[^\]]*\]/.test(value);
};

/** A URL up to, not including, its query string. */
const withoutQuery = (url: string): string => {
  const at = url.indexOf("?");
  return at === -1 ? url : url.slice(0, at);
};

/** The request string a match condition is tested against. */
export const getMatchSource = (
  match: MatchCondition,
  request: RequestParams,
  pathname: string,
  fullUrl: string,
): string => {
  if (match.matchType === MatchTypeValues.HEADER) {
    const name = (match.headerName || "").toLowerCase();
    return request.headers?.[name] ?? "";
  }
  if (match.matchType === MatchTypeValues.COOKIE) {
    return request.cookies ?? "";
  }

  const isRegexMode =
    match.matchType === MatchTypeValues.REGEX ||
    match.matchOperator === MatchOperator.REGEX;

  const seesQuery = mentionsQueryString(match.matchValue, isRegexMode);

  // A scheme in the pattern means it was written against the whole URL. It gets
  // the same query-string treatment as a path below, for the same two reasons:
  // an anchored pattern otherwise stops matching once a query is present, and a
  // capture otherwise carries the query into `$1` for `appendQueryStringIfNeeded`
  // to add a second time (CF-43).
  if (isRegexMode && isFullUrlRegex(match.matchValue)) {
    return seesQuery ? fullUrl : withoutQuery(fullUrl);
  }

  // A path match whose pattern does not mention the query string compares the
  // bare path; one that does keeps it.
  //
  // Regex mode is included, not just `equals`. An anchored pattern like
  // `^/old/([a-z]+)$` is written against a path, so testing it against
  // `path?utm=x` never matches and the rule silently stops firing for exactly
  // the traffic a migration cares about. And in `formatResult` the capture feeds
  // `$1`, so a query string swallowed by `(.*)` comes back in the target and is
  // then appended a second time. `contains` is left alone: an unanchored
  // substring search over the full path+query is a reasonable thing to have
  // meant, and nothing in the model says otherwise.
  const isPathLike =
    match.matchType === MatchTypeValues.PATH ||
    match.matchType === MatchTypeValues.REGEX;
  const usePathnameOnly =
    isPathLike &&
    (match.matchOperator === MatchOperator.EQUALS || isRegexMode) &&
    !seesQuery;

  const pathSource = usePathnameOnly ? pathname : request.path;

  const lookup: Record<MatchType, string> = {
    [MatchTypeValues.HOSTNAME]: request.hostname,
    [MatchTypeValues.PATH]: pathSource,
    [MatchTypeValues.PROTOCOL]: request.protocol,
    [MatchTypeValues.REGEX]: pathSource,
    [MatchTypeValues.HEADER]: "",
    [MatchTypeValues.COOKIE]: "",
  };

  return lookup[match.matchType] ?? "";
};
