import type { MatchOperator } from "../rule-types.js";
import { MatchOperator as MatchOperatorValues } from "../rule-types.js";

/**
 * A single space-separated match variant, which may contain `*` wildcards.
 */
export const checkAkamaiVariant = (
  testVal: string,
  variant: string,
  operator: MatchOperator,
): boolean => {
  if (!variant.includes("*")) {
    return operator === MatchOperatorValues.CONTAINS
      ? testVal.includes(variant)
      : testVal === variant;
  }

  const escaped = variant.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const regexStr = escaped.replace(/\*/g, ".*");

  const regex = new RegExp(
    operator === MatchOperatorValues.CONTAINS ? regexStr : `^${regexStr}$`,
  );
  return regex.test(testVal);
};
