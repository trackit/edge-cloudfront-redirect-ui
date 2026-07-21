import { describe, expect, it } from "vitest";
import { DEFAULT_CACHE_TTL_MS, resolveConfig } from "../src/config.js";

const baked = {
  tableName: "baked-table",
  tableRegion: "eu-west-1",
  cacheTtlMs: 30_000,
};

describe("resolveConfig", () => {
  it("uses baked config when no env vars are set", () => {
    expect(resolveConfig(baked, {})).toEqual(baked);
  });

  it("lets env vars override baked config", () => {
    expect(
      resolveConfig(baked, {
        RULES_TABLE_NAME: "env-table",
        RULES_TABLE_REGION: "us-east-2",
        RULES_CACHE_TTL_MS: "5000",
      }),
    ).toEqual({
      tableName: "env-table",
      tableRegion: "us-east-2",
      cacheTtlMs: 5000,
    });
  });

  it("defaults the cache TTL to 60s when neither source sets it", () => {
    const config = resolveConfig(
      { tableName: "t", tableRegion: "us-east-1" },
      {},
    );
    expect(config.cacheTtlMs).toBe(DEFAULT_CACHE_TTL_MS);
    expect(config.cacheTtlMs).toBe(60_000);
  });

  it("throws when no table name is available from either source", () => {
    expect(() => resolveConfig({ tableRegion: "us-east-1" }, {})).toThrow(
      /no table name/,
    );
  });

  it("throws when no region is available from either source", () => {
    expect(() => resolveConfig({ tableName: "t" }, {})).toThrow(
      /no table region/,
    );
  });

  it("rejects a non-numeric cache TTL rather than silently using NaN", () => {
    expect(() => resolveConfig(baked, { RULES_CACHE_TTL_MS: "soon" })).toThrow(
      /non-negative number/,
    );
  });
});
