import { describe, expect, it } from "vitest";
import { asApiError, takenPriorities } from "../src/rules";
import { ApiError } from "../src/api";
import type { Rule } from "../src/api";

/**
 * The pure half of the rules module. The hook itself — loading, the in-place
 * refetch, and the host-switch race — is DOM behaviour, so it belongs to the
 * Playwright suite (phase 2), per the note in vitest.config.ts. What is left
 * here needs no DOM: which priorities a type already holds, and the fallback for
 * a throw that is not already an ApiError.
 */

const rule = (sk: string, type: Rule["type"]): Rule =>
  ({ pk: "www.example.com", sk, type }) as Rule;

const RULES: Rule[] = [
  rule("REDIRECT#00100", "erMatchRule"),
  rule("REDIRECT#00200", "erMatchRule"),
  rule("REWRITE#00100", "frMatchRule"),
];

describe("takenPriorities", () => {
  it("returns only the requested type's priorities", () => {
    // Redirects and rewrites are independent sequences, so priority 100 on a
    // rewrite must not count as taken for a redirect.
    expect(takenPriorities(RULES, "erMatchRule")).toEqual([100, 200]);
    expect(takenPriorities(RULES, "frMatchRule")).toEqual([100]);
  });

  it("excludes the rule being edited, so its own priority reads as free", () => {
    // Without this, editing a rule and saving it at its current priority would
    // collide with itself.
    expect(takenPriorities(RULES, "erMatchRule", "REDIRECT#00100")).toEqual([
      200,
    ]);
  });

  it("is empty when the type has no rules", () => {
    expect(takenPriorities([], "erMatchRule")).toEqual([]);
  });
});

describe("asApiError", () => {
  it("passes an ApiError through untouched", () => {
    // The server already described the failure; nothing here improves on it.
    const refusal = new ApiError({
      status: 409,
      code: "RULE_EXISTS",
      message: "priority taken",
    });
    expect(asApiError(refusal, "fallback")).toBe(refusal);
  });

  it.each([
    ["a rejected fetch", new TypeError("Failed to fetch")],
    ["a string", "boom"],
    ["null", null],
  ])(
    "wraps %s in a MALFORMED_RESPONSE with the fallback message",
    (_c, thrown) => {
      const error = asApiError(
        thrown,
        "Could not load the rules for this host",
      );

      expect(error).toBeInstanceOf(ApiError);
      expect(error.code).toBe("MALFORMED_RESPONSE");
      expect(error.status).toBe(0);
      expect(error.message).toBe("Could not load the rules for this host");
    },
  );
});
