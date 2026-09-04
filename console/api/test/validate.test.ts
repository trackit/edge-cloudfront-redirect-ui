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

  describe("country conditions", () => {
    const withCountry = (match: Record<string, unknown>) => ({
      ...redirectRule,
      matches: [{ matchType: "country", matchOperator: "equals", ...match }],
    });

    it.each([
      ["a single code", "FR"],
      ["several codes, space-separated", "BE FR NL"],
      // The point of the whole design: the schema validates the format, not the
      // list of countries. CloudFront publishes no list and its geolocation
      // database changes without notice, so an unrecognised code has to be
      // storable or a legitimate new country is unusable until we ship again.
      ["a code we have never heard of", "FR XK"],
    ])("accepts %s", (_label, matchValue) => {
      expect(() => validateRule(withCountry({ matchValue }))).not.toThrow();
    });

    it("accepts negate, which is how an exclude list is expressed", () => {
      expect(() =>
        validateRule(withCountry({ matchValue: "FR", negate: true })),
      ).not.toThrow();
    });

    it.each([
      ["lowercase", "fr"],
      ["comma-separated", "FR,DE"],
      ["a three-letter code", "FRA"],
      ["a double space", "FR  DE"],
      ["a trailing space", "FR "],
      ["empty", ""],
    ])("rejects %s", (_label, matchValue) => {
      expect(() => validateRule(withCountry({ matchValue }))).toThrowError(
        ApiError,
      );
    });

    it("rejects any operator but equals", () => {
      // A country condition is a set membership test. `contains` would silently
      // match FRA against FR, and `regex` would let a rule ReDoS the edge on a
      // value that is always two letters.
      expect(() =>
        validateRule(
          withCountry({ matchValue: "FR", matchOperator: "contains" }),
        ),
      ).toThrowError(ApiError);
    });

    it("still rejects headerName on a country condition", () => {
      // The headerName conditional and the country one now sit side by side in
      // an allOf; this is the guard that adding the second did not loosen the
      // first.
      expect(() =>
        validateRule(withCountry({ matchValue: "FR", headerName: "x-env" })),
      ).toThrowError(ApiError);
    });
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
