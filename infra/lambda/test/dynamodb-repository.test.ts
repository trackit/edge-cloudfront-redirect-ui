import { describe, expect, it } from "vitest";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoDBRuleRepository } from "../src/dynamodb-repository.js";

/**
 * Captures the command instead of calling DynamoDB. Everything else in the
 * suite fakes the repository wholesale, so this is the only place the real
 * query shape is checked.
 */
class CapturingClient {
  readonly sent: QueryCommand[] = [];

  constructor(private readonly response: { Items?: unknown[] } = {}) {}

  async send(command: QueryCommand): Promise<{ Items?: unknown[] }> {
    this.sent.push(command);
    return this.response;
  }
}

const repoWith = (
  client: CapturingClient,
  tableName = "test-rules",
): DynamoDBRuleRepository =>
  new DynamoDBRuleRepository(
    tableName,
    "us-east-1",
    client as unknown as DynamoDBDocumentClient,
  );

describe("DynamoDBRuleRepository", () => {
  it("queries pk = host with begins_with on the sort key", async () => {
    const client = new CapturingClient({ Items: [] });

    await repoWith(client).queryByPrefix("www.example.com", "REDIRECT#");

    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]).toBeInstanceOf(QueryCommand);
    expect(client.sent[0]!.input).toMatchObject({
      TableName: "test-rules",
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :skPrefix)",
      ExpressionAttributeValues: {
        ":pk": "www.example.com",
        ":skPrefix": "REDIRECT#",
      },
    });
  });

  it("reads ascending, so DynamoDB returns rules in priority order", async () => {
    const client = new CapturingClient({ Items: [] });

    await repoWith(client).queryByPrefix("www.example.com", "REDIRECT#");

    expect(client.sent[0]!.input.ScanIndexForward).toBe(true);
  });

  it("passes the REWRITE prefix through unchanged", async () => {
    const client = new CapturingClient({ Items: [] });

    await repoWith(client).queryByPrefix("assets.example.com", "REWRITE#");

    expect(client.sent[0]!.input.ExpressionAttributeValues).toEqual({
      ":pk": "assets.example.com",
      ":skPrefix": "REWRITE#",
    });
  });

  it("never filters on disabled — that is the caller's job", async () => {
    const client = new CapturingClient({ Items: [] });

    await repoWith(client).queryByPrefix("www.example.com", "REDIRECT#");

    // A FilterExpression would still bill the read and would hide rules the
    // service expects to see; disabled is filtered in RulesService instead.
    expect(client.sent[0]!.input.FilterExpression).toBeUndefined();
  });

  it("returns the items DynamoDB sent back", async () => {
    const items = [{ pk: "www.example.com", sk: "REDIRECT#00100" }];
    const client = new CapturingClient({ Items: items });

    const result = await repoWith(client).queryByPrefix(
      "www.example.com",
      "REDIRECT#",
    );

    expect(result).toEqual(items);
  });

  it("returns an empty array when the response carries no Items", async () => {
    const client = new CapturingClient({});

    const result = await repoWith(client).queryByPrefix(
      "www.example.com",
      "REDIRECT#",
    );

    expect(result).toEqual([]);
  });

  it("propagates a query failure so the handler can pass the request through", async () => {
    const client = new CapturingClient();
    client.send = async () => {
      throw new Error("ProvisionedThroughputExceededException");
    };

    await expect(
      repoWith(client).queryByPrefix("www.example.com", "REDIRECT#"),
    ).rejects.toThrow("ProvisionedThroughputExceededException");
  });
});
