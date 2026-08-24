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

export interface AuthConfig {
  userPoolId: string;
  clientId: string;
  clientSecret: string;
  /** Hosted UI base URL, e.g. https://edgeroute.auth.us-east-1.amazoncognito.com */
  domain: string;
}

/**
 * Reads the Cognito config.
 *
 * Separate from `getConfig` and called per request rather than at module load:
 * the rules and targets routes work without any of this, and a deployment that
 * has not been given a pool yet should fail on the auth routes alone rather than
 * refusing to start.
 */
export const getAuthConfig = (): AuthConfig => {
  const userPoolId = process.env.COGNITO_USER_POOL_ID;
  const clientId = process.env.COGNITO_CLIENT_ID;
  const clientSecret = process.env.COGNITO_CLIENT_SECRET;
  const domain = process.env.COGNITO_DOMAIN;

  if (!userPoolId || !clientId || !clientSecret || !domain) {
    throw new Error(
      "Cognito is not configured: COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID, COGNITO_CLIENT_SECRET and COGNITO_DOMAIN must all be set",
    );
  }

  return { userPoolId, clientId, clientSecret, domain };
};
