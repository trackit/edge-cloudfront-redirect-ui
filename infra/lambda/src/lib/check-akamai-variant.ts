import type { MatchOperator } from "../rule-types.js";
import { MatchOperator as MatchOperatorValues } from "../rule-types.js";

/**
 * A single space-separated match variant, which may contain `*` wildcards.
 *
 * This is the definition of the glob dialect: `*` is the only wildcard, every
 * other regex metacharacter — `?` included — is a literal. The Akamai importer
 * mirrors this escape class in `wildcardToRegex`
 * (`console/ui/src/domain/akamaiImport.ts`), so a match value means the same
 * thing whether it is evaluated here or rewritten at import time. There is no
 * shared module to hold it: `shared/` carries JSON Schemas, not code.
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
