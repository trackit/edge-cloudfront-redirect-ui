import { describe, expect, it } from "vitest";
import {
  describeDropped,
  needsDistributionCheck,
} from "../src/domain/geoReadiness";
import type { MatchCondition } from "../src/api";

const m = (over: Partial<MatchCondition>): MatchCondition =>
  ({
    matchType: "path",
    matchOperator: "equals",
    matchValue: "/x",
    ...over,
  }) as MatchCondition;

describe("needsDistributionCheck", () => {
  it("asks for a country rule of either kind", () => {
    const country = m({ matchType: "country", matchValue: "FR" });
    expect(needsDistributionCheck("redirect", [country])).toBe(true);
    expect(needsDistributionCheck("rewrite", [country])).toBe(true);
  });

  it("asks for a rewrite negating a header or a cookie, by negate or notEquals", () => {
    expect(
      needsDistributionCheck("rewrite", [
        m({ matchType: "header", headerName: "X-Beta", negate: true }),
      ]),
    ).toBe(true);
    expect(
      needsDistributionCheck("rewrite", [
        m({
          matchType: "cookie",
          matchOperator: "notEquals",
          matchValue: "a=1",
        }),
      ]),
    ).toBe(true);
  });

  it("asks for any header or cookie condition on a rewrite: the API decides which ones matter", () => {
    expect(
      needsDistributionCheck("rewrite", [
        m({ matchType: "header", headerName: "X-Beta" }),
      ]),
    ).toBe(true);
  });

  it("does not ask for a path-only rewrite, nor for a redirect", () => {
    expect(needsDistributionCheck("rewrite", [m({})])).toBe(false);
    expect(
      needsDistributionCheck("redirect", [
        m({ matchType: "header", headerName: "X-Beta", negate: true }),
      ]),
    ).toBe(false);
  });
});

describe("describeDropped", () => {
  it("names the behavior and what it drops, once each", () => {
    expect(
      describeDropped([
        { pathPattern: "*", matchType: "header", name: "X-Beta" },
        { pathPattern: "*", matchType: "header", name: "X-Beta" },
        { pathPattern: "/shop/*", matchType: "cookie", name: null },
      ]),
    ).toBe(
      "the default behavior does not send on the header X-Beta; /shop/* does not send on every cookie",
    );
  });
});
