import { describe, expect, it } from "vitest";
import { validateRule } from "../src/lib/validate.js";
import { ApiError } from "../src/lib/errors.js";
import type { ValidationDetail } from "../src/lib/ajv-errors.js";

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

  /**
   * A cookie condition names its cookie, the way a header condition names its
   * header. Without the name the edge has nothing to compare but the whole
   * `Cookie` header, so the condition either never matches or matches unrelated
   * cookies — a rule that reads fine and behaves at random. The schema refuses it
   * rather than store it.
   */
  const cookieMatch = (over: Record<string, unknown> = {}) => ({
    ...redirectRule,
    matches: [
      {
        matchType: "cookie",
        matchOperator: "equals",
        matchValue: "on",
        ...over,
      },
    ],
  });

  it("accepts a cookie condition that names its cookie", () => {
    expect(() =>
      validateRule(cookieMatch({ cookieName: "ab_test" })),
    ).not.toThrow();
  });

  it("rejects a cookie condition with no cookie name", () => {
    expect(() => validateRule(cookieMatch())).toThrowError(ApiError);
  });

  it.each([
    ["a whole name=value pair", "locale=nl"],
    ["several cookies", "locale=nl; region=be"],
    ["a space", "ab test"],
  ])("rejects a cookie name that is %s", (_case, cookieName) => {
    // RFC 6265 forbids separators in a cookie name, and a name carrying one
    // matches nothing a viewer sends: the rule would be stored and never fire.
    expect(() => validateRule(cookieMatch({ cookieName }))).toThrowError(
      ApiError,
    );
  });

  /**
   * A schema conditional makes Ajv report twice: the missing field, and the fact
   * that the branch it sits in failed. The second names nothing and gives the
   * user nothing to change, so it does not reach the response.
   */
  it("reports the missing field once, without Ajv's branch bookkeeping", () => {
    try {
      validateRule(cookieMatch());
      expect.unreachable();
    } catch (err) {
      const details = (err as ApiError).details as ValidationDetail[];
      expect(details).toEqual([
        {
          path: "/matches/0",
          message: "must have required property 'cookieName'",
          params: { missingProperty: "cookieName" },
        },
      ]);
    }
  });

  it("rejects a cookie name on a condition that is not a cookie", () => {
    // Same shape as headerName: naming a cookie on a path condition would be
    // stored and then ignored, which is worse than a refusal.
    expect(() =>
      validateRule({
        ...redirectRule,
        matches: [
          {
            matchType: "path",
            matchOperator: "equals",
            matchValue: "/old",
            cookieName: "ab_test",
          },
        ],
      }),
    ).toThrowError(ApiError);
  });

  it("rejects a redirect body carrying a rewrite-only field", () => {
    // additionalProperties:false — forwardSettings is not valid on a redirect.
    const mixed = { ...redirectRule, forwardSettings: { pathAndQS: "/x" } };
    expect(() => validateRule(mixed)).toThrowError(ApiError);
  });

  it("names the offending property in details, not just the message", () => {
    // Ajv's additionalProperties message says only "must NOT have additional
    // properties" — the key lives in params, which the SPA needs to highlight
    // the field. Guards the params passthrough in toDetails.
    const extra = { ...redirectRule, notAField: 1 };
    try {
      validateRule(extra);
      expect.unreachable();
    } catch (err) {
      const details = (err as ApiError).details as {
        message: string;
        params?: { additionalProperty?: string };
      }[];
      const offending = details.find(
        (d) => d.params?.additionalProperty === "notAField",
      );
      expect(offending).toBeDefined();
    }
  });

  it("caps details so a large body cannot amplify past the response limit", () => {
    // One junk key yields one detail. Uncapped, a big body produces a response
    // over Lambda's 6 MB limit, and API Gateway replaces the error envelope
    // with its own 502.
    const junk = Object.fromEntries(
      Array.from({ length: 500 }, (_, i) => [`junk${i}`, 1]),
    );
    try {
      validateRule({ ...redirectRule, ...junk });
      expect.unreachable();
    } catch (err) {
      const details = (err as ApiError).details as { message: string }[];
      expect(details.length).toBeLessThanOrEqual(51);
      expect(details.at(-1)?.message).toMatch(/further errors omitted/);
    }
  });
});
