import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `DynamoTargetsRepository` itself — the existing targets-repository test covers
 * the in-memory fake, which is strictly stronger than DynamoDB (synchronous and
 * strongly consistent), so it cannot catch a wrong command, a missing
 * `ConsistentRead`, or a Scan that stops at the first page.
 *
 * The DocumentClient is mocked at the `docClient` seam: no network, no AWS.
 */

const send = vi.fn();

vi.mock("../src/lib/dynamo.js", () => ({
  docClient: () => ({ send }),
  resetDocClients: () => undefined,
}));

const TABLE = "console-targets";

const target = {
  id: "t1",
  name: "Prod",
  region: "us-east-1",
  tableName: "rules-prod",
};

const repository = async () => {
  const { DynamoTargetsRepository } =
    await import("../src/lib/targets-repository.js");
  return new DynamoTargetsRepository();
};

/** The command name and input of the nth send() call. */
const call = (n = 0) => {
  const command = send.mock.calls[n]?.[0] as {
    constructor: { name: string };
    input: Record<string, unknown>;
  };
  return { name: command.constructor.name, input: command.input };
};

beforeEach(() => {
  vi.resetModules();
  send.mockReset();
  process.env["TARGETS_TABLE_NAME"] = TABLE;
  process.env["AWS_REGION"] = "us-east-1";
});

describe("DynamoTargetsRepository", () => {
  it("reads a single target consistently", async () => {
    // The SPA reads a target back right after creating it; an eventually
    // consistent GetItem can 404 on the id it was just handed.
    send.mockResolvedValue({ Item: target });

    expect(await (await repository()).get("t1")).toEqual(target);
    expect(call()).toMatchObject({
      name: "GetCommand",
      input: { TableName: TABLE, Key: { id: "t1" }, ConsistentRead: true },
    });
  });

  it("returns null rather than undefined for a missing target", async () => {
    send.mockResolvedValue({});

    expect(await (await repository()).get("nope")).toBeNull();
  });

  it("follows LastEvaluatedKey instead of returning a short list", async () => {
    // A Scan returns at most 1 MB per page. Stopping at the first page would
    // silently drop targets with no error at all.
    const second = { ...target, id: "t2" };
    send
      .mockResolvedValueOnce({
        Items: [target],
        LastEvaluatedKey: { id: "t1" },
      })
      .mockResolvedValueOnce({ Items: [second] });

    expect(await (await repository()).list()).toEqual([target, second]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(call(0).input["ExclusiveStartKey"]).toBeUndefined();
    expect(call(1).input["ExclusiveStartKey"]).toEqual({ id: "t1" });
  });

  it("treats a page with no Items as empty", async () => {
    send.mockResolvedValue({});

    expect(await (await repository()).list()).toEqual([]);
  });

  it("writes the whole item on create and put", async () => {
    send.mockResolvedValue({});
    const repo = await repository();

    await repo.create(target);
    await repo.put({ ...target, name: "Renamed" });

    expect(call(0)).toMatchObject({
      name: "PutCommand",
      input: { TableName: TABLE, Item: target },
    });
    expect(call(1).input["Item"]).toMatchObject({ name: "Renamed" });
  });

  it("deletes only the registry item, never a table", async () => {
    // Criterion 6 at the command level: whatever else changes, this must never
    // become a DeleteTableCommand.
    send.mockResolvedValue({});

    await (await repository()).delete("t1");

    expect(call()).toMatchObject({
      name: "DeleteCommand",
      input: { TableName: TABLE, Key: { id: "t1" } },
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("round-trips an optional roleArn", async () => {
    const withRole = {
      ...target,
      roleArn: "arn:aws:iam::123456789012:role/edgeroute-target-prod",
    };
    send.mockResolvedValue({ Item: withRole });

    expect(await (await repository()).get("t1")).toEqual(withRole);
  });
});
