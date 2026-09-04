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
  // Returned here rather than from the lookup below so a country is never run
  // through the path/full-URL logic. The schema pins a country condition to
  // `equals`, but this reads items straight out of DynamoDB, and a rule written
  // by hand before that constraint existed should still be tested against the
  // country and not against the URL.
  if (match.matchType === MatchTypeValues.COUNTRY) {
    return request.country ?? "";
  }

  const isRegexMode =
    match.matchType === MatchTypeValues.REGEX ||
    match.matchOperator === MatchOperator.REGEX;

  if (isRegexMode && isFullUrlRegex(match.matchValue)) {
    return fullUrl;
  }

  // An `equals` path match with no `?` in the pattern compares the bare path;
  // everything else keeps the query string so patterns can match against it.
  const usePathnameOnly =
    (match.matchType === MatchTypeValues.PATH ||
      match.matchType === MatchTypeValues.REGEX) &&
    match.matchOperator === MatchOperator.EQUALS &&
    !match.matchValue.includes("?");

  const pathSource = usePathnameOnly ? pathname : request.path;

  const lookup: Record<MatchType, string> = {
    [MatchTypeValues.HOSTNAME]: request.hostname,
    [MatchTypeValues.PATH]: pathSource,
    [MatchTypeValues.PROTOCOL]: request.protocol,
    [MatchTypeValues.REGEX]: pathSource,
    [MatchTypeValues.HEADER]: "",
    [MatchTypeValues.COOKIE]: "",
    [MatchTypeValues.COUNTRY]: "",
  };

  return lookup[match.matchType] ?? "";
};
