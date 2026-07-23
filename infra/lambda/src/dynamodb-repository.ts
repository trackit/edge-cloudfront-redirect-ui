import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

export interface RuleRepository {
  queryByPrefix<T>(pk: string, skPrefix: string): Promise<T[]>;
}

/**
 * Read-only slice of the source project's DynamoDBRepository — the edge only
 * ever runs `pk = host AND begins_with(sk, prefix)`. Writes belong to the
 * console API.
 */
export class DynamoDBRuleRepository implements RuleRepository {
  private readonly client: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    region: string,
    client?: DynamoDBDocumentClient,
  ) {
    this.client =
      client ??
      DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
        marshallOptions: { removeUndefinedValues: true },
      });
  }

  async queryByPrefix<T>(pk: string, skPrefix: string): Promise<T[]> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :skPrefix)",
        ExpressionAttributeValues: { ":pk": pk, ":skPrefix": skPrefix },
        // Ascending sort key order == ascending priority.
        ScanIndexForward: true,
      }),
    );
    return (result.Items ?? []) as T[];
  }
}
