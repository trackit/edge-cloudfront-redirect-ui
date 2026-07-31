import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedTarget } from "../src/lib/targets-repository.js";

/**
 * `DynamoRulesRepository` itself. The handler tests run over the in-memory fake,
 * which is strictly stronger than DynamoDB — synchronous, strongly consistent,
 * and it cannot fail — so it cannot catch a Query that stops at the first page, a
 * missing `ScanIndexForward`, a delete that forgot its condition, or a table the
 * API has no access to.
 *
 * The DocumentClient is mocked at the `docClient` seam: no network, no AWS.
 */

const send = vi.fn();
const docClient = vi.fn(() => ({ send }));

vi.mock("../src/lib/dynamo.js", () => ({
  docClient,
  resetDocClients: () => undefined,
}));

const target: ResolvedTarget = {
  region: "eu-west-1",
  tableName: "rules-prod",
  roleArn: "arn:aws:iam::123456789012:role/edgeroute-target-prod",
};

const HOST = "www.example.com";

const rule = (sk: string) => ({ pk: HOST, sk, type: "erMatchRule" });

const repository = async (coordinates = target) => {
  const { DynamoRulesRepository } =
    await import("../src/lib/rules-repository.js");
  return new DynamoRulesRepository(coordinates);
};

/** The command name and input of the nth send() call. */
const call = (n = 0) => {
  const command = send.mock.calls[n]?.[0] as {
    constructor: { name: string };
    input: Record<string, unknown>;
  };
  return { name: command.constructor.name, input: command.input };
};

/** An AWS SDK failure — only `name` is ever inspected. */
const awsError = (name: string): Error =>
  Object.assign(new Error(name), { name });

beforeEach(() => {
  vi.resetModules();
  send.mockReset();
  docClient.mockClear();
});

describe("reaching the target's table", () => {
  it("builds its client from the target, not the API's own config", async () => {
    send.mockResolvedValue({ Items: [] });
    await (await repository()).listByHost(HOST);

    expect(docClient).toHaveBeenCalledWith(
      "eu-west-1",
      "arn:aws:iam::123456789012:role/edgeroute-target-prod",
    );
  });

  it("passes no role for a target that has none", async () => {
    send.mockResolvedValue({ Items: [] });
    await (
      await repository({ region: "us-east-1", tableName: "rules-dev" })
    ).listByHost(HOST);

    expect(docClient).toHaveBeenCalledWith("us-east-1", undefined);
  });
});

describe("listByHost", () => {
  it("queries the partition in ascending sort-key order", async () => {
    send.mockResolvedValue({ Items: [rule("REDIRECT#00100")] });

    const items = await (await repository()).listByHost(HOST);

    expect(items).toEqual([rule("REDIRECT#00100")]);
    expect(call()).toMatchObject({
      name: "QueryCommand",
      input: {
        TableName: "rules-prod",
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": HOST },
        ScanIndexForward: true,
      },
    });
  });

  it("follows LastEvaluatedKey to the end", async () => {
    // A Query returns at most 1 MB per page; stopping at the first would drop a
    // busy host's lowest-priority rules with no error at all.
    send
      .mockResolvedValueOnce({
        Items: [rule("REDIRECT#00100")],
        LastEvaluatedKey: { pk: HOST, sk: "REDIRECT#00100" },
      })
      .mockResolvedValueOnce({ Items: [rule("REDIRECT#00200")] });

    const items = await (await repository()).listByHost(HOST);

    expect(items.map((i) => i.sk)).toEqual([
      "REDIRECT#00100",
      "REDIRECT#00200",
    ]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(call(1).input).toMatchObject({
      ExclusiveStartKey: { pk: HOST, sk: "REDIRECT#00100" },
    });
  });

  it("sends no ExclusiveStartKey on the first page", async () => {
    send.mockResolvedValue({ Items: [] });
    await (await repository()).listByHost(HOST);

    expect(call().input).not.toHaveProperty("ExclusiveStartKey");
  });
});

describe("get", () => {
  it("reads the item consistently", async () => {
    // The SPA reads a rule back right after writing it; an eventually consistent
    // GetItem can 404 on the rule it was just handed.
    send.mockResolvedValue({ Item: rule("REDIRECT#00100") });

    const item = await (await repository()).get(HOST, "REDIRECT#00100");

    expect(item).toEqual(rule("REDIRECT#00100"));
    expect(call()).toMatchObject({
      name: "GetCommand",
      input: {
        TableName: "rules-prod",
        Key: { pk: HOST, sk: "REDIRECT#00100" },
        ConsistentRead: true,
      },
    });
  });

  it("returns null for a missing item", async () => {
    send.mockResolvedValue({});

    expect(await (await repository()).get(HOST, "REDIRECT#00100")).toBeNull();
  });
});

describe("delete", () => {
  it("deletes conditionally on the item existing", async () => {
    send.mockResolvedValue({});

    expect(await (await repository()).delete(HOST, "REDIRECT#00100")).toBe(
      true,
    );
    expect(call()).toMatchObject({
      name: "DeleteCommand",
      input: {
        TableName: "rules-prod",
        Key: { pk: HOST, sk: "REDIRECT#00100" },
        ConditionExpression: "attribute_exists(pk)",
      },
    });
  });

  it("reports false when the rule was not there", async () => {
    send.mockRejectedValue(awsError("ConditionalCheckFailedException"));

    expect(await (await repository()).delete(HOST, "REDIRECT#00100")).toBe(
      false,
    );
  });

  it("does not swallow other failures", async () => {
    send.mockRejectedValue(awsError("ProvisionedThroughputExceededException"));

    await expect(
      (await repository()).delete(HOST, "REDIRECT#00100"),
    ).rejects.toThrow("ProvisionedThroughputExceededException");
  });
});

describe("an unreachable target", () => {
  const unreachable = [
    ["the assumed role is refused", "AccessDenied"],
    ["the role cannot read the table", "AccessDeniedException"],
    ["the role cannot be assumed at all", "CredentialsProviderError"],
    ["the registered table does not exist", "ResourceNotFoundException"],
  ] as const;

  it.each(unreachable)("502s when %s", async (_label, name) => {
    // Targets are registered at runtime, IAM is granted at apply time — a valid
    // registry entry the API has no path to is a configuration problem, and a
    // bare 500 gives the operator nothing to act on.
    send.mockRejectedValue(awsError(name));

    await expect((await repository()).listByHost(HOST)).rejects.toMatchObject({
      status: 502,
      code: "TARGET_UNREACHABLE",
    });
  });

  it("names the table, region and role in the message", async () => {
    send.mockRejectedValue(awsError("AccessDeniedException"));

    await expect(
      (await repository()).get(HOST, "REDIRECT#00100"),
    ).rejects.toThrow(/rules-prod.*eu-west-1.*edgeroute-target-prod/);
  });

  it("leaves an unrelated failure to become a 500", async () => {
    send.mockRejectedValue(awsError("InternalServerError"));

    await expect((await repository()).listByHost(HOST)).rejects.toThrow(
      "InternalServerError",
    );
  });
});
