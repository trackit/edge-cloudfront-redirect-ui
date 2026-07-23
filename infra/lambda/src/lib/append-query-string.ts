import type { RedirectRule } from "../rule-types.js";

export const appendQueryStringIfNeeded = (
  targetString: string,
  search: string,
  rule: RedirectRule,
): string => {
  if (!search) return targetString;

  let appendQS = false;
  if (rule.type === "erMatchRule") {
    appendQS = rule.useIncomingQueryString === true;
  } else if (rule.forwardSettings.useIncomingQueryString === true) {
    appendQS = true;
  } else if (
    // A rewrite that doesn't replace the path keeps the incoming query string
    // unless it opts out explicitly.
    rule.forwardSettings.pathAndQS === undefined &&
    rule.forwardSettings.useIncomingQueryString !== false
  ) {
    appendQS = true;
  }

  if (appendQS) {
    return (
      targetString +
      (targetString.includes("?") ? "&" : "?") +
      search.substring(1)
    );
  }

  return targetString;
};
