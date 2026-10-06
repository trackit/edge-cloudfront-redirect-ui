import { describe, expect, it } from "vitest";
import {
  describeMatch,
  describeMatches,
  isGeoRedirect,
  ruleFrom,
  ruleKindLabel,
  ruleTo,
} from "../src/domain/ruleSummary";
import type { ForwardSettings, MatchCondition, Rule } from "../src/api";

/**
 * The one-line renderings the list, the editor preview and the delete dialog all
 * lean on. Pure string-building, so what is pinned here is the wording — the "  ·
 *  " join, "any request" for a rule with no conditions, and the order the "to"
 * side names an origin and a path in.
 */

const match = (over: Partial<MatchCondition> = {}): MatchCondition => ({
  matchType: "path",
  matchOperator: "equals",
  matchValue: "/old",
  negate: false,
  caseSensitive: false,
  ...over,
});

const redirect = (over: Partial<Rule> = {}): Rule =>
  ({
    pk: "www.example.com",
    sk: "REDIRECT#00100",
    type: "erMatchRule",
    statusCode: 301,
    redirectURL: "https://www.example.com/new",
    useIncomingQueryString: true,
    matches: [match()],
    ...over,
  }) as Rule;

const rewrite = (
  forwardSettings: ForwardSettings,
  over: Partial<Rule> = {},
): Rule =>
  ({
    pk: "www.example.com",
    sk: "REWRITE#00100",
    type: "frMatchRule",
    matches: [match()],
    forwardSettings,
    ...over,
  }) as Rule;

describe("describeMatch", () => {
  it.each([
    ["a plain condition", match(), "path equals /old"],
    [
      "a negated one",
      match({ negate: true, matchOperator: "contains", matchValue: "staging" }),
      "path not contains staging",
    ],
    [
      "a header, prefixed with its name",
      match({ matchType: "header", headerName: "x-env", matchValue: "prod" }),
      "header:x-env equals prod",
    ],
    [
      "a header missing its name",
      match({ matchType: "header", matchValue: "prod" }),
      "header:? equals prod",
    ],
    // A country reads as set membership rather than showing its stored form.
    // `country equals BE FR` would describe the encoding: the operator is
    // `equals` only because the edge splits the value on spaces and matches any
    // variant.
    [
      "a country condition, as an inclusion",
      match({ matchType: "country", matchValue: "BE FR" }),
      "country in BE, FR",
    ],
    [
      "an excluding country condition",
      match({
        matchType: "country",
        matchOperator: "notEquals",
        matchValue: "BE FR",
      }),
      "country not in BE, FR",
    ],
    [
      "a legacy negated country condition, as an exclusion",
      match({ matchType: "country", matchValue: "US", negate: true }),
      "country not in US",
    ],
    [
      "a country condition with no country yet",
      match({ matchType: "country", matchValue: "" }),
      "country in ",
    ],
  ])("renders %s", (_case, condition, expected) => {
    expect(describeMatch(condition)).toBe(expected);
  });
});

describe("describeMatches", () => {
  it("says so when a rule matches everything", () => {
    expect(describeMatches(redirect({ matches: [] }))).toBe(
      "matches every request",
    );
  });

  it("joins conditions with a middot", () => {
    const rule = redirect({
      matches: [match({ matchValue: "/a" }), match({ matchValue: "/b" })],
    });
    expect(describeMatches(rule)).toBe("path equals /a  ·  path equals /b");
  });
});

describe("ruleFrom", () => {
  it("is the first condition's value", () => {
    expect(ruleFrom(redirect({ matches: [match({ matchValue: "/x" })] }))).toBe(
      "/x",
    );
  });

  it("is 'any request' when there are no conditions", () => {
    expect(ruleFrom(redirect({ matches: [] }))).toBe("any request");
  });
});

describe("ruleTo", () => {
  it("is a redirect's target URL", () => {
    expect(ruleTo(redirect({ redirectURL: "https://h/x" }))).toBe(
      "https://h/x",
    );
  });

  it.each([
    [
      "an S3 origin",
      { origin: { s3: { domainName: "bucket.s3.amazonaws.com" } } },
      "S3 · bucket.s3.amazonaws.com",
    ],
    [
      "a custom origin, named by protocol",
      { origin: { custom: { protocol: "https-only", domainName: "api.x" } } },
      "https-only · api.x",
    ],
    [
      "an origin with the path appended",
      {
        origin: { custom: { protocol: "https-only", domainName: "api.x" } },
        pathAndQS: "/v1",
      },
      "https-only · api.x/v1",
    ],
    ["a path-only rewrite", { pathAndQS: "/only" }, "/only"],
    ["a rewrite that changes nothing", {}, "no change"],
    // Origin present but neither S3 nor custom — reachable only by accident
    // through the schema's anyOf, and says "origin" rather than rendering blank.
    ["an empty origin", { origin: {} }, "origin"],
  ] as const)("is %s", (_case, forwardSettings, expected) => {
    expect(ruleTo(rewrite(forwardSettings as ForwardSettings))).toBe(expected);
  });
});

describe("ruleKindLabel", () => {
  it("names a redirect with its status code, and a rewrite plainly", () => {
    expect(ruleKindLabel(redirect({ statusCode: 302 }))).toBe("302 redirect");
    expect(ruleKindLabel(rewrite({ pathAndQS: "/x" }))).toBe("rewrite");
  });
});

describe("isGeoRedirect", () => {
  const geo = (type: "erMatchRule" | "frMatchRule") =>
    ({
      pk: "www.example.com",
      sk: type === "erMatchRule" ? "REDIRECT#00100" : "REWRITE#00100",
      type,
      statusCode: 302,
      redirectURL: "https://www.example.fr/",
      forwardSettings: { pathAndQS: "/fr" },
      matches: [
        { matchType: "country", matchOperator: "equals", matchValue: "FR" },
      ],
    }) as unknown as Rule;

  it("flags a redirect that reads the country", () => {
    expect(isGeoRedirect(geo("erMatchRule"))).toBe(true);
  });

  it("leaves a geo rewrite alone, which runs at origin-request anyway", () => {
    expect(isGeoRedirect(geo("frMatchRule"))).toBe(false);
  });

  it("leaves a classic redirect alone", () => {
    const classic = geo("erMatchRule");
    expect(
      isGeoRedirect({
        ...classic,
        matches: [
          { matchType: "path", matchOperator: "equals", matchValue: "/x" },
        ],
      } as Rule),
    ).toBe(false);
  });
});
