import { describe, expect, it } from "vitest";
import { GeoMetrics } from "../src/lib/geo-metrics.js";

const setup = (maxHosts?: number) => {
  let now = 0;
  const lines: string[] = [];
  const metrics = new GeoMetrics({
    now: () => now,
    emit: (line) => lines.push(line),
    functionName: "us-east-1.edge",
    ...(maxHosts === undefined ? {} : { maxHosts }),
  });
  return {
    metrics,
    lines,
    tick: (ms: number) => {
      now += ms;
    },
  };
};

describe("GeoMetrics", () => {
  it("emits nothing before a minute has passed", () => {
    const { metrics, lines } = setup();
    metrics.record("www.example.com", true);
    metrics.flushIfDue();
    expect(lines).toEqual([]);
  });

  it("emits one EMF line per host with both counts after a minute", () => {
    const { metrics, lines, tick } = setup();
    metrics.record("www.example.com", true);
    metrics.record("WWW.example.com", false);
    metrics.record("shop.example.com", false);
    tick(60_000);
    metrics.flushIfDue();

    const parsed = lines.map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      _aws: {
        Timestamp: 60_000,
        CloudWatchMetrics: [
          {
            Namespace: "EdgeRoute/Geo",
            Dimensions: [["FunctionName"], ["FunctionName", "Host"]],
            Metrics: [
              { Name: "CountryRulesEvaluated", Unit: "Count" },
              { Name: "CountryRulesSkipped", Unit: "Count" },
            ],
          },
        ],
      },
      FunctionName: "us-east-1.edge",
      Host: "www.example.com",
      CountryRulesEvaluated: 2,
      CountryRulesSkipped: 1,
    });
  });

  it("starts from zero after a flush", () => {
    const { metrics, lines, tick } = setup();
    metrics.record("a.example.com", true);
    tick(60_000);
    metrics.flushIfDue();
    tick(60_000);
    metrics.flushIfDue();
    expect(lines).toHaveLength(1);
  });

  it("caps the hosts it tracks, so a wildcard domain cannot grow it forever", () => {
    const { metrics, lines, tick } = setup(2);
    for (const h of ["a", "b", "c"]) metrics.record(`${h}.example.com`, false);
    tick(60_000);
    metrics.flushIfDue();
    expect(lines).toHaveLength(2);
  });

  it("carries no viewer data: only the host, the counts and the function name", () => {
    const { metrics, lines, tick } = setup();
    metrics.record("www.example.com", true);
    tick(60_000);
    metrics.flushIfDue();
    expect(Object.keys(JSON.parse(lines[0] ?? "{}") as object).sort()).toEqual([
      "CountryRulesEvaluated",
      "CountryRulesSkipped",
      "FunctionName",
      "Host",
      "_aws",
    ]);
  });
});
