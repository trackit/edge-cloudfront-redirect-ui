export interface EdgeConfig {
  tableName: string;
  tableRegion: string;
  cacheTtlMs: number;
}

export const DEFAULT_CACHE_TTL_MS = 60_000;

/**
 * Baked config is the source of truth at the edge — Lambda@Edge strips
 * environment variables, so `RULES_*` only ever resolves for local runs and
 * tests. See edge-config.generated.example.ts.
 */
export const resolveConfig = (
  generated: Partial<EdgeConfig> = {},
  env: NodeJS.ProcessEnv = process.env,
): EdgeConfig => {
  const tableName = env["RULES_TABLE_NAME"] ?? generated.tableName;
  const tableRegion = env["RULES_TABLE_REGION"] ?? generated.tableRegion;

  if (!tableName) {
    throw new Error(
      "redirect-rules: no table name — set RULES_TABLE_NAME or bake tableName into edge-config.generated.ts",
    );
  }
  if (!tableRegion) {
    throw new Error(
      "redirect-rules: no table region — set RULES_TABLE_REGION or bake tableRegion into edge-config.generated.ts",
    );
  }

  return {
    tableName,
    tableRegion,
    cacheTtlMs: parseCacheTtl(env["RULES_CACHE_TTL_MS"], generated.cacheTtlMs),
  };
};

const parseCacheTtl = (raw: string | undefined, baked?: number): number => {
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(
        `redirect-rules: RULES_CACHE_TTL_MS must be a non-negative number, got "${raw}"`,
      );
    }
    return parsed;
  }
  return baked ?? DEFAULT_CACHE_TTL_MS;
};
