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

  // CF-38. The console already refuses these in the form; the point of having
  // them here too is the rules the form never sees — imports, curl, a client
  // written against the OpenAPI spec.
  describe("redirectURL", () => {
    const withUrl = (redirectURL: string) => ({ ...redirectRule, redirectURL });

    it.each([
      "https://www.example.com/new",
      "http://www.example.com/new",
      "HTTPS://www.example.com/new",
      // The "Relative URL" toggle's form of the same field.
      "/new",
      "/",
      // A path may contain a backslash or a double slash — just not lead with
      // one, which is what the rejections below are about.
      "/a//b",
      "/a\\b",
      // Regex captures are substituted at the edge, after validation.
      "https://www.example.com/$1",
      "/archive/$1",
      // A target that *starts* with a capture is a template: its leading segment
      // comes from the match, so there is nothing here to check. An Akamai import
      // produces these (CF-20), and the console judges whether the condition's
      // group opens where the path does — see the schema's $comment.
      "$1/$2/",
      "$1/gone",
      "$10/x",
      "$1",
    ])("accepts %j", (url) => {
      expect(() => validateRule(withUrl(url))).not.toThrow();
    });

    it.each([
      "not a url",
      // A bare path with no leading slash: relative to the current directory at
      // the edge, which is not a thing the rule author can reason about.
      "new/landing",
      "www.example.com/new",
      // Schemes the edge cannot put in a Location header meaningfully.
      "ftp://www.example.com/new",
      "javascript:alert(1)",
      // A scheme with nowhere to send the visitor.
      "https://",
      // Protocol-relative and its backslash variant: both read as a path and
      // both leave the host, so a rule written by a client that never saw the
      // console could 301 an entire host off-site. The browser resolves
      // "//evil.example.com" against the scheme alone.
      "//evil.example.com/phish",
      "/\\evil.example.com",
      "/\\\\evil.example.com",
      // Would split the response if it reached the header verbatim.
      "https://www.example.com/new\r\nX-Injected: 1",
      "/new\npath",
      " https://www.example.com/new",
      "https://www.example.com/a b",
      // Widening for templates does not widen to the off-host case: an unfilled
      // group substitutes as "", so these expand to "//evil.example.com" and
      // leave the host — the very thing the second alternative forbids.
      "$1//evil.example.com",
      "$1/\\evil.example.com",
      // `$0` is not a capture reference: the edge substitutes `$1`..`$n`, so
      // this is a bare relative path with a dollar sign in it.
      "$0/x",
      // A capture that is not what the value *starts* with decides nothing about
      // the leading segment, so the ordinary rules still apply.
      "x$1/y",
      // Whitespace is no more acceptable in a template than anywhere else.
      "$1/a b",
    ])("rejects %j", (url) => {
      expect(() => validateRule(withUrl(url))).toThrowError(ApiError);
    });

    it("points at the field it rejected", () => {
      try {
        validateRule(withUrl("not a url"));
        expect.unreachable();
      } catch (err) {
        const details = (err as ApiError).details as { path: string }[];
        expect(details.some((d) => d.path === "/redirectURL")).toBe(true);
      }
    });
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
