import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

const clients = new Map<string, DynamoDBDocumentClient>();

/**
 * A DynamoDB DocumentClient per region, memoized across warm invocations. The
 * targets registry uses the API's own region; per-target rule tables (ER-203)
 * may live in other regions, which is why the cache is keyed by region.
 */
export const docClient = (region: string): DynamoDBDocumentClient => {
  let client = clients.get(region);
  if (!client) {
    client = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
      marshallOptions: { removeUndefinedValues: true },
    });
    clients.set(region, client);
  }
  return client;
};
