import { describe, expect, it } from "vitest";
import { validateRule } from "../src/lib/validate.js";
import { ApiError } from "../src/lib/errors.js";

const redirectRule = {
  pk: "www.example.com",
  sk: "REDIRECT#00100",
  type: "erMatchRule",
  statusCode: 301,
  redirectURL: "https://www.example.com/new",
  matches: [{ matchType: "path", matchOperator: "equals", matchValue: "/old" }],
};

const rewriteRule = {
  pk: "www.example.com",
  sk: "REWRITE#00100",
  type: "frMatchRule",
  matches: [{ matchType: "path", matchOperator: "equals", matchValue: "/old" }],
  forwardSettings: { pathAndQS: "/new" },
};

describe("validateRule", () => {
  it("accepts a valid redirect rule", () => {
    expect(() => validateRule(redirectRule)).not.toThrow();
  });

  it("accepts a valid rewrite rule", () => {
    expect(() => validateRule(rewriteRule)).not.toThrow();
  });

  it("rejects a non-object body", () => {
    expect(() => validateRule("nope")).toThrowError(ApiError);
    expect(() => validateRule(null)).toThrowError(ApiError);
    expect(() => validateRule([redirectRule])).toThrowError(ApiError);
  });

  it("rejects an unknown rule type before touching a schema", () => {
    try {
      validateRule({ ...redirectRule, type: "whatRule" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(400);
      expect((err as ApiError).code).toBe("VALIDATION_ERROR");
    }
  });

  it("reports schema violations with field-level details", () => {
    // Missing required redirectURL; statusCode out of the allowed enum.
    const bad = { ...redirectRule, statusCode: 418, redirectURL: undefined };
    try {
      validateRule(bad);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const e = err as ApiError;
      expect(e.status).toBe(400);
      expect(Array.isArray(e.details)).toBe(true);
      expect((e.details as unknown[]).length).toBeGreaterThan(0);
    }
  });

  it("rejects a redirect body carrying a rewrite-only field", () => {
    // additionalProperties:false — forwardSettings is not valid on a redirect.
    const mixed = { ...redirectRule, forwardSettings: { pathAndQS: "/x" } };
    expect(() => validateRule(mixed)).toThrowError(ApiError);
  });
});
