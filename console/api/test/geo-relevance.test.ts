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
    ).toEqual({
      outcome: "blocked",
      relevant: [dflt],
      ambiguous: false,
      dropped: [],
    });
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

describe("a rewrite that negates a header or cookie", () => {
  const passes = (headers: string[], cookies: string[] | "all" = []) => ({
    headers: [{ all: false, names: headers, except: [] }],
    cookies: [
      cookies === "all"
        ? { all: true, names: [], except: [] }
        : { all: false, names: cookies, except: [] },
    ],
  });
  const on = (forwards: ReturnType<typeof passes>): BehaviorReadiness[] => [
    { pathPattern: "*", verdict: "ok", forwards },
  ];
  const notHeader = (name: string, over: Record<string, unknown> = {}) => ({
    matchType: "header",
    headerName: name,
    matchOperator: "equals",
    matchValue: "1",
    negate: true,
    ...over,
  });
  const notCookie = (
    matchValue: string,
    over: Record<string, unknown> = {},
  ) => ({
    matchType: "cookie",
    matchOperator: "contains",
    matchValue,
    negate: true,
    ...over,
  });

  it("is blocked when the behavior drops the header, which then matches every viewer", () => {
    expect(
      geoDecision("rewrite", [notHeader("X-Beta")], checked(on(passes([])))),
    ).toMatchObject({
      outcome: "blocked",
      dropped: [{ pathPattern: "*", matchType: "header", name: "X-Beta" }],
    });
  });

  it("is ok when the header is sent on, whatever its case", () => {
    expect(
      geoDecision(
        "rewrite",
        [notHeader("X-Beta")],
        checked(on(passes(["x-beta"]))),
      ).outcome,
    ).toBe("ok");
  });

  it("treats notEquals as a negation too", () => {
    expect(
      geoDecision(
        "rewrite",
        [notHeader("X-Beta", { negate: false, matchOperator: "notEquals" })],
        checked(on(passes([]))),
      ).outcome,
    ).toBe("blocked");
  });

  it("reads a cookie's name from its value, and needs every cookie when it cannot", () => {
    expect(
      geoDecision(
        "rewrite",
        [notCookie("beta=1")],
        checked(on(passes([], ["beta"]))),
      ).outcome,
    ).toBe("ok");
    expect(
      geoDecision(
        "rewrite",
        [notCookie("beta=1")],
        checked(on(passes([], ["other"]))),
      ),
    ).toMatchObject({
      outcome: "blocked",
      dropped: [{ matchType: "cookie", name: "beta" }],
    });
    expect(
      geoDecision(
        "rewrite",
        [notCookie("beta.*", { matchOperator: "regex" })],
        checked(on(passes([], ["beta"]))),
      ).outcome,
    ).toBe("blocked");
    expect(
      geoDecision(
        "rewrite",
        [notCookie("beta.*", { matchOperator: "regex" })],
        checked(on(passes([], "all"))),
      ).outcome,
    ).toBe("ok");
  });

  it("honours allExcept", () => {
    const allBut = (except: string[]): BehaviorReadiness[] => [
      {
        pathPattern: "*",
        verdict: "ok",
        forwards: { headers: [{ all: true, names: [], except }], cookies: [] },
      },
    ];
    expect(
      geoDecision("rewrite", [notHeader("X-Beta")], checked(allBut([])))
        .outcome,
    ).toBe("ok");
    expect(
      geoDecision("rewrite", [notHeader("X-Beta")], checked(allBut(["X-Beta"])))
        .outcome,
    ).toBe("blocked");
  });

  it("leaves a positive condition, a redirect and a disabled behavior alone", () => {
    expect(
      geoDecision(
        "rewrite",
        [notHeader("X-Beta", { negate: false })],
        checked(on(passes([]))),
      ).outcome,
    ).toBe("ok");
    // A redirect without a country runs at viewer-request, where every header is.
    expect(
      geoDecision("redirect", [notHeader("X-Beta")], checked(on(passes([]))))
        .outcome,
    ).toBe("ok");
  });

  it("is unverifiable when the distribution could not be read", () => {
    expect(
      geoDecision("rewrite", [notHeader("X-Beta")], {
        status: "unknown",
        cause: "transient",
        reason: "r",
      }).outcome,
    ).toBe("unverifiable");
  });

  it("only looks at the behaviors serving the rule", () => {
    const behaviors: BehaviorReadiness[] = [
      { pathPattern: "/beta/*", verdict: "ok", forwards: passes(["X-Beta"]) },
      { pathPattern: "*", verdict: "ok", forwards: passes([]) },
    ];
    expect(
      geoDecision(
        "rewrite",
        [path("/beta/x"), notHeader("X-Beta")],
        checked(behaviors),
      ).outcome,
    ).toBe("ok");
  });

  it("does not count allViewer as sending on the headers CloudFront adds itself", () => {
    const allViewer: BehaviorReadiness[] = [
      {
        pathPattern: "*",
        verdict: "ok",
        forwards: {
          headers: [{ all: true, names: [], except: [] }],
          cookies: [],
        },
      },
    ];
    expect(
      geoDecision(
        "rewrite",
        [notHeader("CloudFront-Is-Mobile-Viewer", { matchValue: "true" })],
        checked(allViewer),
      ).outcome,
    ).toBe("blocked");
    expect(
      geoDecision(
        "rewrite",
        [notHeader("CloudFront-Is-Mobile-Viewer", { matchValue: "true" })],
        checked(on(passes(["CloudFront-Is-Mobile-Viewer"]))),
      ).outcome,
    ).toBe("ok");
  });

  it("judges by what the condition does with an absent value, not by negate alone", () => {
    const dropped = checked(on(passes([])));
    // Not negated, but true for "": just as dangerous.
    expect(
      geoDecision(
        "rewrite",
        [
          notHeader("X-Beta", {
            negate: false,
            matchOperator: "regex",
            matchValue: "^$",
          }),
        ],
        dropped,
      ).outcome,
    ).toBe("blocked");
    expect(
      geoDecision(
        "rewrite",
        [notHeader("X-Beta", { negate: false, matchValue: "*" })],
        dropped,
      ).outcome,
    ).toBe("blocked");
    // negate on notEquals is equals: false for "", harmless.
    expect(
      geoDecision(
        "rewrite",
        [notHeader("X-Beta", { matchOperator: "notEquals" })],
        dropped,
      ).outcome,
    ).toBe("ok");
  });

  it("needs every cookie for a value that does not name its cookie", () => {
    expect(
      geoDecision(
        "rewrite",
        [notCookie("premium")],
        checked(on(passes([], ["tier"]))),
      ).outcome,
    ).toBe("blocked");
    expect(
      geoDecision(
        "rewrite",
        [notCookie("premium")],
        checked(on(passes([], "all"))),
      ).outcome,
    ).toBe("ok");
  });

  it("compares cookie names regardless of case when the rule does", () => {
    expect(
      geoDecision(
        "rewrite",
        [notCookie("Beta=1")],
        checked(on(passes([], ["beta"]))),
      ).outcome,
    ).toBe("ok");
    expect(
      geoDecision(
        "rewrite",
        [notCookie("Beta=1", { caseSensitive: true })],
        checked(on(passes([], ["beta"]))),
      ).outcome,
    ).toBe("blocked");
  });

  it("always says what was dropped, empty when nothing was", () => {
    expect(
      geoDecision("rewrite", [path("/x")], checked(ORDER)).dropped,
    ).toEqual([]);
  });
});
