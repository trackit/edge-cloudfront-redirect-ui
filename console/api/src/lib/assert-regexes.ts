import safeRegex from "safe-regex";
import { ApiError } from "./errors.js";
import type { ValidationDetail } from "./ajv-errors.js";

/**
 * Refuses a rule carrying a regular expression the edge cannot safely run.
 *
 * The Lambda@Edge runs these patterns on every request that reaches the rule, so
 * a pattern that does not compile is a condition that can never match, and a
 * pattern with catastrophic backtracking is a self-inflicted denial of service:
 * one crafted URL and the function burns its timeout, on every request.
 *
 * The console checks the same two things in `validateDraft` before spending a
 * request, but that is a courtesy to the user, not a guarantee — anything that
 * is not the console writes straight to the table. This is the guarantee, and it
 * deliberately uses the same paths and wording so one bad pattern is described
 * the same way wherever it is refused.
 *
 * `safe-regex` is a heuristic (it reasons about star height), so it will not
 * catch every explosive pattern. Bounding execution at the edge is the complete
 * answer and is still to come; this closes the bypass, not the heuristic's gaps.
 */

/** Both ways a condition ends up in regex mode at the edge. */
const isRegexMode = (match: { matchType?: unknown; matchOperator?: unknown }) =>
  match.matchType === "regex" || match.matchOperator === "regex";

export const assertRegexes = (item: unknown): void => {
  const matches = (item as { matches?: unknown }).matches;
  if (!Array.isArray(matches)) return;

  const details: ValidationDetail[] = [];

  matches.forEach((raw, at) => {
    const match = (raw ?? {}) as { matchValue?: unknown };
    if (!isRegexMode(match as Record<string, unknown>)) return;
    if (typeof match.matchValue !== "string") return;

    const path = `/matches/${at}/matchValue`;
    try {
      new RegExp(match.matchValue);
    } catch {
      details.push({ path, message: "is not a valid regular expression" });
      // An unparseable pattern cannot be judged for backtracking, and one error
      // per value reads better than two overlapping ones.
      return;
    }

    if (!safeRegex(match.matchValue)) {
      details.push({
        path,
        message:
          "is a potentially catastrophic regular expression (ReDoS) that " +
          "could hang the edge on every request",
      });
    }
  });

  if (details.length > 0) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Rule failed schema validation",
      details,
    );
  }
};
