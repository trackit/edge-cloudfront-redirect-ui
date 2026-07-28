export interface ApiConfig {
  targetsTableName: string;
  region: string;
}

/**
 * Reads the API's Lambda environment config. Unlike the Lambda@Edge — which
 * bakes config because @edge strips env vars — this is a regular Lambda, so env
 * vars are the normal mechanism.
 */
export const getConfig = (): ApiConfig => {
  const targetsTableName = process.env.TARGETS_TABLE_NAME;
  if (!targetsTableName) {
    throw new Error("TARGETS_TABLE_NAME is not set");
  }

  return {
    targetsTableName,
    // AWS_REGION is injected by the Lambda runtime.
    region:
      process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1",
  };
};
