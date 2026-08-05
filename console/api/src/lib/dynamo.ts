import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";

const clients = new Map<string, DynamoDBDocumentClient>();

/**
 * Credential provider that assumes a target's role. Returned as a function so
 * the SDK calls it lazily and refreshes on `expiration`.
 *
 * Registering a target does now reach for the role — `verify-table.ts` describes
 * the table under it — but a role that cannot be assumed still does not fail the
 * registration: that verifier treats every failure other than "no such table" as
 * inconclusive and allows it. So a misconfigured role continues to surface when
 * the target's rules are touched, as a 502.
 */
const assumeRole = (roleArn: string, region: string) => async () => {
  const sts = new STSClient({ region });
  const out = await sts.send(
    new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: "edgeroute-console-api",
    }),
  );

  const creds = out.Credentials;
  if (!creds?.AccessKeyId || !creds.SecretAccessKey || !creds.SessionToken) {
    throw new Error(`AssumeRole on ${roleArn} returned no credentials`);
  }

  return {
    accessKeyId: creds.AccessKeyId,
    secretAccessKey: creds.SecretAccessKey,
    sessionToken: creds.SessionToken,
    ...(creds.Expiration ? { expiration: creds.Expiration } : {}),
  };
};

/**
 * A DynamoDB DocumentClient per (region, role), memoized across warm
 * invocations. The targets registry uses the API's own region and credentials; a
 * target's rules table may live in another region and — with `roleArn` — under
 * another role or account, which is why the cache key covers both.
 */
export const docClient = (
  region: string,
  roleArn?: string,
): DynamoDBDocumentClient => {
  const key = roleArn ? `${region} ${roleArn}` : region;

  let client = clients.get(key);
  if (!client) {
    client = DynamoDBDocumentClient.from(
      new DynamoDBClient({
        region,
        ...(roleArn ? { credentials: assumeRole(roleArn, region) } : {}),
      }),
      { marshallOptions: { removeUndefinedValues: true } },
    );
    clients.set(key, client);
  }
  return client;
};

/** Test seam — the client cache would otherwise outlive a single test. */
export const resetDocClients = (): void => clients.clear();
