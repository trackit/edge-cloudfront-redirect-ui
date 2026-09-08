import type {
  MatchCondition,
  MatchType,
  RequestParams,
} from "../rule-types.js";
import { MatchType as MatchTypeValues, MatchOperator } from "../rule-types.js";
import { isFullUrlRegex } from "./is-full-url-regex.js";

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

  if (isRegexMode && isFullUrlRegex(match.matchValue)) {
    return fullUrl;
  }

  // A path match with no `?` in the pattern compares the bare path; a pattern
  // that mentions `?` clearly means to see the query string, and keeps it.
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
    !match.matchValue.includes("?");

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
