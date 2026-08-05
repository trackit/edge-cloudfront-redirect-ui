import { describe, expect, it } from "vitest";
import { isRedirect, isRewrite, priorityOf } from "../src/api/types";
import type { Rule } from "../src/api/types";

/**
 * The three runtime helpers in an otherwise types-only module. `erMatchRule` and
 * `frMatchRule` are the discriminators the shared schemas use, and they are not
 * guessable from the names — a typo here narrows every rule to the wrong branch.
 */

const rule = (over: Partial<Rule>): Rule =>
  ({
    pk: "www.example.com",
    sk: "REDIRECT#00100",
    type: "erMatchRule",
    ...over,
  }) as Rule;

describe("isRedirect / isRewrite", () => {
  it("narrows on the schema's discriminator", () => {
    const redirect = rule({ type: "erMatchRule" });
    const rewrite = rule({ type: "frMatchRule", sk: "REWRITE#00100" });

    expect(isRedirect(redirect)).toBe(true);
    expect(isRewrite(redirect)).toBe(false);
    expect(isRewrite(rewrite)).toBe(true);
    expect(isRedirect(rewrite)).toBe(false);
  });
});

describe("priorityOf", () => {
  it("reads the number out of a sort key", () => {
    expect(priorityOf("REDIRECT#00100")).toBe(100);
    expect(priorityOf("REWRITE#00001")).toBe(1);
    // Leading zeros are padding for lexicographic ordering at the edge, not
    // octal — 00010 is ten.
    expect(priorityOf("REDIRECT#00010")).toBe(10);
  });

  it("is NaN for a key with no priority", () => {
    // Sorting on NaN is silent; this documents that the caller has to check
    // rather than that the value is meaningful.
    expect(priorityOf("REDIRECT")).toBeNaN();
    expect(priorityOf("")).toBeNaN();
    expect(priorityOf("REDIRECT#")).toBeNaN();
  });
});
