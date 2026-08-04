import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedTarget } from "../src/lib/targets-repository.js";
import type { RuleItem } from "../src/lib/rules-repository.js";

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

const rule = (sk: string): RuleItem => ({
  pk: HOST,
  sk,
  type: "erMatchRule",
});

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

describe("listHosts", () => {
  it("scans the table for keys only", async () => {
    send.mockResolvedValue({
      Items: [
        { pk: HOST, sk: "REDIRECT#00100" },
        { pk: HOST, sk: "REWRITE#00150" },
      ],
    });

    const hosts = await (await repository()).listHosts();

    expect(hosts).toEqual([{ host: HOST, redirects: 1, rewrites: 1 }]);
    expect(call()).toMatchObject({
      name: "ScanCommand",
      input: {
        TableName: "rules-prod",
        // Without the projection every rule body is read to count it, and the
        // 1 MB page limit counts bytes read.
        ProjectionExpression: "pk, sk",
      },
    });
  });

  it("follows LastEvaluatedKey to the end", async () => {
    // Stopping at the first page would silently hide whole hosts — the failure
    // looks like a host that "does not exist" rather than an error.
    send
      .mockResolvedValueOnce({
        Items: [{ pk: "a.example.com", sk: "REDIRECT#00100" }],
        LastEvaluatedKey: { pk: "a.example.com", sk: "REDIRECT#00100" },
      })
      .mockResolvedValueOnce({
        Items: [{ pk: "b.example.com", sk: "REWRITE#00100" }],
      });

    const hosts = await (await repository()).listHosts();

    expect(hosts.map((h) => h.host)).toEqual([
      "a.example.com",
      "b.example.com",
    ]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(call(1).input).toMatchObject({
      ExclusiveStartKey: { pk: "a.example.com", sk: "REDIRECT#00100" },
    });
  });

  it("counts a host split across two pages once", async () => {
    // The fold runs over every page together; per-page folding would report the
    // same host twice.
    send
      .mockResolvedValueOnce({
        Items: [{ pk: HOST, sk: "REDIRECT#00100" }],
        LastEvaluatedKey: { pk: HOST, sk: "REDIRECT#00100" },
      })
      .mockResolvedValueOnce({ Items: [{ pk: HOST, sk: "REDIRECT#00200" }] });

    expect(await (await repository()).listHosts()).toEqual([
      { host: HOST, redirects: 2, rewrites: 0 },
    ]);
  });

  it("sends no ExclusiveStartKey on the first page", async () => {
    send.mockResolvedValue({ Items: [] });
    await (await repository()).listHosts();

    expect(call().input).not.toHaveProperty("ExclusiveStartKey");
  });

  it("is empty for an empty table", async () => {
    send.mockResolvedValue({});
    expect(await (await repository()).listHosts()).toEqual([]);
  });
});

describe("deleteHost", () => {
  /** A BatchWriteCommand's delete keys for the mocked table. */
  const deletedKeys = (n: number) =>
    (
      call(n).input as unknown as {
        RequestItems: Record<string, { DeleteRequest: { Key: RuleItem } }[]>;
      }
    ).RequestItems["rules-prod"].map((r) => r.DeleteRequest.Key.sk);

  it("reads the host's keys consistently, then batch-deletes them", async () => {
    send
      .mockResolvedValueOnce({
        Items: [
          { pk: HOST, sk: "REDIRECT#00100" },
          { pk: HOST, sk: "REWRITE#00150" },
        ],
      })
      .mockResolvedValueOnce({});

    expect(await (await repository()).deleteHost(HOST)).toBe(2);

    expect(call()).toMatchObject({
      name: "QueryCommand",
      input: {
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": HOST },
        ProjectionExpression: "pk, sk",
        // An eventually consistent read can miss a rule written moments ago,
        // and skipping the newest rule is the one an author notices.
        ConsistentRead: true,
      },
    });
    expect(call(1).name).toBe("BatchWriteCommand");
    expect(deletedKeys(1)).toEqual(["REDIRECT#00100", "REWRITE#00150"]);
  });

  it("writes nothing when the host has no rules", async () => {
    // Otherwise this sends an empty BatchWriteItem, which DynamoDB rejects as a
    // ValidationException — a 500 where the handler wants a plain 404.
    send.mockResolvedValueOnce({ Items: [] });

    expect(await (await repository()).deleteHost(HOST)).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("splits more than 25 rules across batches", async () => {
    // BatchWriteItem's hard cap. A 26-item request is rejected outright.
    const keys = Array.from({ length: 26 }, (_, i) => ({
      pk: HOST,
      sk: `REDIRECT#${String(i).padStart(5, "0")}`,
    }));
    send
      .mockResolvedValueOnce({ Items: keys })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    expect(await (await repository()).deleteHost(HOST)).toBe(26);

    expect(send).toHaveBeenCalledTimes(3);
    expect(deletedKeys(1)).toHaveLength(25);
    expect(deletedKeys(2)).toHaveLength(1);
  });

  it("follows the key Query across pages", async () => {
    send
      .mockResolvedValueOnce({
        Items: [{ pk: HOST, sk: "REDIRECT#00100" }],
        LastEvaluatedKey: { pk: HOST, sk: "REDIRECT#00100" },
      })
      .mockResolvedValueOnce({ Items: [{ pk: HOST, sk: "REDIRECT#00200" }] })
      .mockResolvedValueOnce({});

    expect(await (await repository()).deleteHost(HOST)).toBe(2);
    expect(deletedKeys(2)).toEqual(["REDIRECT#00100", "REDIRECT#00200"]);
  });

  it("re-sends items DynamoDB left unprocessed", async () => {
    // The dangerous case: BatchWriteItem answers 200 while declining part of the
    // request, so the SDK's own retries never fire. Left alone, those rules
    // survive a delete that reported success.
    const unprocessed = [
      { DeleteRequest: { Key: { pk: HOST, sk: "REWRITE#00150" } } },
    ];
    send
      .mockResolvedValueOnce({
        Items: [
          { pk: HOST, sk: "REDIRECT#00100" },
          { pk: HOST, sk: "REWRITE#00150" },
        ],
      })
      .mockResolvedValueOnce({
        UnprocessedItems: { "rules-prod": unprocessed },
      })
      .mockResolvedValueOnce({});

    expect(await (await repository()).deleteHost(HOST)).toBe(2);

    expect(send).toHaveBeenCalledTimes(3);
    expect(deletedKeys(2)).toEqual(["REWRITE#00150"]);
  });

  it("gives up loudly when a batch never drains", async () => {
    // Reporting 204 here would claim the host was removed while some of its
    // rules are still live at the edge.
    send.mockResolvedValueOnce({ Items: [{ pk: HOST, sk: "REDIRECT#00100" }] });
    send.mockResolvedValue({
      UnprocessedItems: {
        "rules-prod": [
          { DeleteRequest: { Key: { pk: HOST, sk: "REDIRECT#00100" } } },
        ],
      },
    });

    await expect((await repository()).deleteHost(HOST)).rejects.toThrow(
      /undeleted/,
    );
  });

  it("502s an unreachable target rather than a bare 500", async () => {
    send.mockRejectedValue(awsError("AccessDeniedException"));

    await expect((await repository()).deleteHost(HOST)).rejects.toMatchObject({
      status: 502,
      code: "TARGET_UNREACHABLE",
    });
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

describe("create", () => {
  it("writes only if the key is free", async () => {
    send.mockResolvedValue({});

    expect(await (await repository()).create(rule("REDIRECT#00100"))).toBe(
      true,
    );
    expect(call()).toMatchObject({
      name: "PutCommand",
      input: {
        TableName: "rules-prod",
        Item: rule("REDIRECT#00100"),
        ConditionExpression: "attribute_not_exists(pk)",
      },
    });
  });

  it("reports false instead of overwriting", async () => {
    send.mockRejectedValue(awsError("ConditionalCheckFailedException"));

    expect(await (await repository()).create(rule("REDIRECT#00100"))).toBe(
      false,
    );
  });
});

describe("replace", () => {
  it("writes only if the rule is already there", async () => {
    send.mockResolvedValue({});

    expect(await (await repository()).replace(rule("REDIRECT#00100"))).toBe(
      true,
    );
    expect(call()).toMatchObject({
      name: "PutCommand",
      input: { ConditionExpression: "attribute_exists(pk)" },
    });
  });

  it("reports false instead of inserting", async () => {
    send.mockRejectedValue(awsError("ConditionalCheckFailedException"));

    expect(await (await repository()).replace(rule("REDIRECT#00100"))).toBe(
      false,
    );
  });
});

describe("move", () => {
  const moved = rule("REDIRECT#00050");

  /** TransactionCanceledException, with a reason per TransactItem. */
  const cancelled = (...codes: (string | undefined)[]): Error =>
    Object.assign(awsError("TransactionCanceledException"), {
      CancellationReasons: codes.map((Code) => (Code ? { Code } : {})),
    });

  it("writes the new key and removes the old one in one transaction", async () => {
    send.mockResolvedValue({});

    expect(await (await repository()).move("REDIRECT#00100", moved)).toBe(
      "moved",
    );

    const { name, input } = call();
    expect(name).toBe("TransactWriteCommand");
    expect(input["TransactItems"]).toEqual([
      {
        Put: {
          TableName: "rules-prod",
          Item: moved,
          ConditionExpression: "attribute_not_exists(pk)",
        },
      },
      {
        Delete: {
          TableName: "rules-prod",
          Key: { pk: HOST, sk: "REDIRECT#00100" },
          ConditionExpression: "attribute_exists(pk)",
        },
      },
    ]);
  });

  it("carries a request token so a retried transaction is a no-op", async () => {
    // Without one, a committed transaction whose response was lost is retried,
    // both conditions then fail, and the caller is told 404 for a move that
    // succeeded — after which re-creating the rule leaves it live at two
    // priorities.
    send.mockResolvedValue({});

    await (await repository()).move("REDIRECT#00100", moved);

    expect(call().input["ClientRequestToken"]).toEqual(expect.any(String));
  });

  it("replaces in place rather than putting one item in a transaction twice", async () => {
    // DynamoDB rejects a transaction touching one item twice, and that
    // ValidationException would surface as a 500.
    send.mockResolvedValue({});

    expect(await (await repository()).move("REDIRECT#00050", moved)).toBe(
      "moved",
    );
    expect(call().name).toBe("PutCommand");
  });

  it("reads the Put's refusal as the destination being taken", async () => {
    send.mockRejectedValue(cancelled("ConditionalCheckFailed", "None"));

    expect(await (await repository()).move("REDIRECT#00100", moved)).toBe(
      "occupied",
    );
  });

  it("reads the Delete's refusal as the source being gone", async () => {
    send.mockRejectedValue(cancelled("None", "ConditionalCheckFailed"));

    expect(await (await repository()).move("REDIRECT#00100", moved)).toBe(
      "missing",
    );
  });

  it("prefers the missing source when both legs refuse", async () => {
    // The caller addressed a rule that no longer exists — the more specific
    // answer, and a 404 rather than a 409 about a rule they never mentioned.
    send.mockRejectedValue(
      cancelled("ConditionalCheckFailed", "ConditionalCheckFailed"),
    );

    expect(await (await repository()).move("REDIRECT#00100", moved)).toBe(
      "missing",
    );
  });

  it("rethrows a cancellation neither condition explains", async () => {
    // A throughput or size failure is not a 404, and must not be reported as
    // one: the move genuinely did not happen for a reason the caller cannot fix.
    send.mockRejectedValue(cancelled("TransactionConflict", "None"));

    await expect(
      (await repository()).move("REDIRECT#00100", moved),
    ).rejects.toThrow("TransactionCanceledException");
  });

  it("rethrows a failure that is not a cancellation at all", async () => {
    send.mockRejectedValue(awsError("ProvisionedThroughputExceededException"));

    await expect(
      (await repository()).move("REDIRECT#00100", moved),
    ).rejects.toThrow("ProvisionedThroughputExceededException");
  });
});

describe("setDisabled", () => {
  it("updates just that attribute and returns the whole item", async () => {
    const toggled = { ...rule("REDIRECT#00100"), disabled: true };
    send.mockResolvedValue({ Attributes: toggled });

    expect(
      await (await repository()).setDisabled(HOST, "REDIRECT#00100", true),
    ).toEqual(toggled);

    expect(call()).toMatchObject({
      name: "UpdateCommand",
      input: {
        TableName: "rules-prod",
        Key: { pk: HOST, sk: "REDIRECT#00100" },
        // An Update, not a Put: a Put would clear whatever a stale client had
        // not sent. `DISABLED` is a reserved word, hence the name placeholder.
        UpdateExpression: "SET #disabled = :disabled",
        ExpressionAttributeNames: { "#disabled": "disabled" },
        ExpressionAttributeValues: { ":disabled": true },
        ConditionExpression: "attribute_exists(pk)",
        ReturnValues: "ALL_NEW",
      },
    });
  });

  it("returns null when there is no such rule", async () => {
    send.mockRejectedValue(awsError("ConditionalCheckFailedException"));

    expect(
      await (await repository()).setDisabled(HOST, "REDIRECT#00100", true),
    ).toBeNull();
  });

  it("does not swallow other failures", async () => {
    send.mockRejectedValue(awsError("ProvisionedThroughputExceededException"));

    await expect(
      (await repository()).setDisabled(HOST, "REDIRECT#00100", false),
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

  it("502s a listHosts scan too", async () => {
    // Its own case because the mapping comes from routing every call through
    // `send()`; a method reaching for `this.client` directly would skip it and
    // surface a bare 500.
    send.mockRejectedValue(awsError("ResourceNotFoundException"));

    await expect((await repository()).listHosts()).rejects.toMatchObject({
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

  it("502s writes too, not just reads", async () => {
    send.mockRejectedValue(awsError("AccessDeniedException"));

    await expect(
      (await repository()).create(rule("REDIRECT#00100")),
    ).rejects.toMatchObject({ status: 502, code: "TARGET_UNREACHABLE" });
    await expect(
      (await repository()).move("REDIRECT#00100", rule("REDIRECT#00050")),
    ).rejects.toMatchObject({ status: 502, code: "TARGET_UNREACHABLE" });
  });
});
