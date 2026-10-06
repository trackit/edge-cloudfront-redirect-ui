import { describe, expect, it } from "vitest";
import {
  behaviorsServing,
  geoDecision,
  globMatches,
} from "../src/lib/geo-relevance.js";
import type {
  BehaviorReadiness,
  GeoReadiness,
} from "../src/lib/geo-readiness.js";

const geo: BehaviorReadiness = { pathPattern: "/geo/*", verdict: "ok" };
const api: BehaviorReadiness = { pathPattern: "/api/*", verdict: "notOurs" };
const dflt: BehaviorReadiness = {
  pathPattern: "*",
  verdict: "cachedWithoutCountry",
};
const ORDER = [geo, api, dflt];

const path = (value: string, over: Record<string, unknown> = {}) => ({
  matchType: "path",
  matchOperator: "equals",
  matchValue: value,
  caseSensitive: true,
  ...over,
});
const country = {
  matchType: "country",
  matchOperator: "equals",
  matchValue: "FR",
};
const checked = (behaviors: BehaviorReadiness[]): GeoReadiness => ({
  status: "checked",
  distributionId: "E2EXAMPLE12345",
  functionIdentified: true,
  behaviors,
});

describe("globMatches", () => {
  it("follows CloudFront: * is any run, ? one character, case-sensitive", () => {
    expect(globMatches("/geo/*", "/geo/fr")).toBe(true);
    expect(globMatches("/geo/*", "/geo")).toBe(false);
    expect(globMatches("/img/?.png", "/img/a.png")).toBe(true);
    expect(globMatches("/img/?.png", "/img/ab.png")).toBe(false);
    expect(globMatches("/Geo/*", "/geo/fr")).toBe(false);
    expect(globMatches("*", "/anything")).toBe(true);
  });

  it("treats every other character literally", () => {
    expect(globMatches("/a.b/*", "/aXb/c")).toBe(false);
    expect(globMatches("/a+(b)/*", "/a+(b)/c")).toBe(true);
  });
});

describe("behaviorsServing", () => {
  it("picks the first matching behavior for an exact path", () => {
    expect(behaviorsServing([path("/geo/fr"), country], ORDER)).toEqual({
      relevant: [geo],
      ambiguous: false,
    });
  });

  it("falls back to the default behavior", () => {
    expect(behaviorsServing([path("/shop")], ORDER).relevant).toEqual([dflt]);
  });

  it("ignores the query string, which CloudFront patterns never see", () => {
    expect(behaviorsServing([path("/geo/fr?x=1")], ORDER).relevant).toEqual([
      geo,
    ]);
  });

  it("keeps a resolved notOurs behavior so the editor can say the rule never runs there", () => {
    expect(behaviorsServing([path("/api/v1")], ORDER).relevant).toEqual([api]);
  });

  it("resolves each space-separated alternative, as the edge accepts any of them", () => {
    const fr: BehaviorReadiness = {
      pathPattern: "/fr/*",
      verdict: "cachedWithoutCountry",
    };
    const safe: BehaviorReadiness = { pathPattern: "*", verdict: "ok" };
    expect(behaviorsServing([path("/a /fr/page")], [fr, safe])).toEqual({
      relevant: [safe, fr],
      ambiguous: false,
    });
    expect(
      geoDecision(
        "rewrite",
        [path("/a /fr/page"), country],
        checked([fr, safe]),
      ).outcome,
    ).toBe("blocked");
  });

  it("is ambiguous when an alternative has a * wildcard, which the edge expands", () => {
    const fr: BehaviorReadiness = {
      pathPattern: "/fr/*",
      verdict: "cachedWithoutCountry",
    };
    const safe: BehaviorReadiness = { pathPattern: "*", verdict: "ok" };
    expect(behaviorsServing([path("/*")], [fr, safe]).ambiguous).toBe(true);
    expect(
      geoDecision("rewrite", [path("/*"), country], checked([fr, safe]))
        .outcome,
    ).toBe("blocked");
  });

  it("matches a pattern written without its leading slash, as CloudFront does", () => {
    const fr: BehaviorReadiness = {
      pathPattern: "fr/*",
      verdict: "cachedWithoutCountry",
    };
    expect(behaviorsServing([path("/fr/page")], [fr, dflt]).relevant).toEqual([
      fr,
    ]);
  });

  it("is ambiguous without an exact, case-sensitive, non-negated path", () => {
    for (const matches of [
      [country],
      [path("/geo", { matchOperator: "contains" })],
      [path("^/geo", { matchOperator: "regex" })],
      [path("/geo/fr", { caseSensitive: undefined })],
      [path("/geo/fr", { negate: true })],
    ]) {
      expect(behaviorsServing(matches, ORDER)).toEqual({
        relevant: [geo, dflt],
        ambiguous: true,
      });
    }
  });
});

describe("geoDecision", () => {
  it("is ok for a rule that does not read the country", () => {
    expect(
      geoDecision("rewrite", [path("/shop")], checked(ORDER)).outcome,
    ).toBe("ok");
  });

  it("blocks a country rewrite served by a behavior caching without the country", () => {
    expect(
      geoDecision("rewrite", [path("/shop"), country], checked(ORDER)),
    ).toEqual({ outcome: "blocked", relevant: [dflt], ambiguous: false });
  });

  it("does not block a rewrite on the uncached geo behavior (the recommended setup)", () => {
    expect(
      geoDecision("rewrite", [path("/geo/fr"), country], checked(ORDER))
        .outcome,
    ).toBe("ok");
  });

  it("blocks an ambiguous rewrite when any candidate caches without the country", () => {
    expect(geoDecision("rewrite", [country], checked(ORDER)).outcome).toBe(
      "blocked",
    );
  });

  it("only warns for a redirect in the same place", () => {
    expect(
      geoDecision("redirect", [path("/shop"), country], checked(ORDER)).outcome,
    ).toBe("warn");
  });

  it("warns, not blocks, for cachedByOriginHeaders", () => {
    const soft: BehaviorReadiness = {
      pathPattern: "*",
      verdict: "cachedByOriginHeaders",
    };
    expect(
      geoDecision("rewrite", [path("/x"), country], checked([soft])).outcome,
    ).toBe("warn");
  });

  it("is unverifiable for a rewrite and a warning for a redirect when unknown", () => {
    const unknown: GeoReadiness = {
      status: "unknown",
      cause: "transient",
      reason: "r",
    };
    expect(geoDecision("rewrite", [country], unknown).outcome).toBe(
      "unverifiable",
    );
    expect(geoDecision("redirect", [country], unknown).outcome).toBe("warn");
  });
});
