import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `assertTableExists` itself. The targets suite stubs this seam out, so nothing
 * there covers which command goes out, where it goes, or — the load-bearing part
 * — which failures reject and which are shrugged off.
 *
 * The DocumentClient is mocked at the `docClient` seam, same as
 * dynamo-targets-repository.test.ts: no network, no AWS.
 */

const send = vi.fn();
const docClient = vi.fn(() => ({ send }));

vi.mock("../src/lib/dynamo.js", () => ({
  docClient,
  resetDocClients: () => undefined,
}));

// Plain static imports: `vi.mock` is hoisted above them, so verify-table.js
// still resolves `docClient` to the mock.
const { assertTableExists } = await import("../src/lib/verify-table.js");
const { ApiError } = await import("../src/lib/errors.js");
type ApiError = InstanceType<typeof ApiError>;

const table = { region: "us-east-1", tableName: "rules-prod" };

const verify = (over: Record<string, unknown> = {}) =>
  assertTableExists({ ...table, ...over });

/** An SDK error as the middleware surfaces it — matched by `name`. */
const awsError = (name: string): Error =>
  Object.assign(new Error(name), { name });

// No `vi.resetModules()` here, unlike the repository suites: it would load
// errors.js a second time, and the ApiError thrown through the fresh copy fails
// `toBeInstanceOf` against the one imported above.
beforeEach(() => {
  send.mockReset();
  docClient.mockClear();
  send.mockResolvedValue({ Table: { TableName: "rules-prod" } });
});

describe("assertTableExists", () => {
  it("describes the table it was given", async () => {
    await verify();

    const command = send.mock.calls[0]?.[0] as {
      constructor: { name: string };
      input: Record<string, unknown>;
    };
    expect(command.constructor.name).toBe("DescribeTableCommand");
    expect(command.input).toEqual({ TableName: "rules-prod" });
  });

  it("resolves when the table is there", async () => {
    await expect(verify()).resolves.toBeUndefined();
  });

  it("reaches the table under the target's region and role", async () => {
    const roleArn = "arn:aws:iam::111111111111:role/edgeroute-target-prod";
    await verify({ region: "eu-west-1", roleArn });

    // A cross-account table is only visible through its role — checking it with
    // the API's own credentials would report every one of them as missing.
    expect(docClient).toHaveBeenCalledWith("eu-west-1", roleArn);
  });

  it("400s a table that does not exist, pointing at /tableName", async () => {
    send.mockRejectedValue(awsError("ResourceNotFoundException"));

    const error = await verify().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);

    const api = error as ApiError;
    expect(api.status).toBe(400);
    expect(api.code).toBe("VALIDATION_ERROR");
    expect(api.details).toMatchObject([{ path: "/tableName" }]);
    // The message has to name what to go and look at.
    expect((api.details as { message: string }[])[0].message).toContain(
      "us-east-1",
    );
  });

  it.each([
    "AccessDeniedException",
    "CredentialsProviderError",
    "ProvisionedThroughputExceededException",
    "TimeoutError",
  ])("allows registration when DescribeTable fails with %s", async (name) => {
    send.mockRejectedValue(awsError(name));

    // Registering is a runtime action, IAM is granted at apply time: a target
    // routinely goes in before the policy that reaches it exists. None of these
    // say the table is absent, so none of them may block registration — they
    // surface later as 502 TARGET_UNREACHABLE.
    await expect(verify()).resolves.toBeUndefined();
  });
});
