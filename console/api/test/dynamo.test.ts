import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The per-target AssumeRole path. Rule persistence (ER-203) is what will call
 * `docClient(region, roleArn)` for real, so without these tests the mechanism
 * ships entirely unexercised — the credential provider, the mapping of STS
 * output, and the two-part cache key would all first run in production.
 *
 * STS is mocked: no network, no AWS.
 */

const send = vi.fn();

vi.mock("@aws-sdk/client-sts", () => ({
  STSClient: class {
    send = send;
  },
  AssumeRoleCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

const ROLE = "arn:aws:iam::123456789012:role/edgeroute-target-prod";
const OTHER_ROLE = "arn:aws:iam::222222222222:role/edgeroute-target-prod";

const credentials = (over: Record<string, unknown> = {}) => ({
  Credentials: {
    AccessKeyId: "ASIAEXAMPLE",
    SecretAccessKey: "secret",
    SessionToken: "token",
    Expiration: new Date("2030-01-01T00:00:00Z"),
    ...over,
  },
});

/** Pulls the provider the client was configured with, then invokes it. */
const resolveCredentials = async (roleArn: string) => {
  const { docClient } = await import("../src/lib/dynamo.js");
  const client = docClient("eu-west-1", roleArn) as unknown as {
    config: { credentials: () => Promise<Record<string, unknown>> };
  };
  return client.config.credentials();
};

beforeEach(async () => {
  vi.resetModules();
  send.mockReset();
  const { resetDocClients } = await import("../src/lib/dynamo.js");
  resetDocClients();
});

afterEach(() => vi.restoreAllMocks());

describe("docClient caching", () => {
  it("reuses one client per region", async () => {
    const { docClient } = await import("../src/lib/dynamo.js");
    expect(docClient("us-east-1")).toBe(docClient("us-east-1"));
    expect(docClient("us-east-1")).not.toBe(docClient("eu-west-1"));
  });

  it("keys on the role as well as the region", async () => {
    const { docClient } = await import("../src/lib/dynamo.js");

    // Two accounts can use the same table name in the same region, so a
    // role-less client must never be handed out for a role-bearing target.
    expect(docClient("us-east-1", ROLE)).not.toBe(docClient("us-east-1"));
    expect(docClient("us-east-1", ROLE)).not.toBe(
      docClient("us-east-1", OTHER_ROLE),
    );
    expect(docClient("us-east-1", ROLE)).toBe(docClient("us-east-1", ROLE));
  });
});

describe("assumed-role credentials", () => {
  it("assumes the target's role and maps the credentials through", async () => {
    send.mockResolvedValue(credentials());

    const creds = await resolveCredentials(ROLE);

    expect(send).toHaveBeenCalledTimes(1);
    expect(
      (send.mock.calls[0]?.[0] as { input: Record<string, unknown> }).input,
    ).toMatchObject({ RoleArn: ROLE });
    expect(creds).toMatchObject({
      accessKeyId: "ASIAEXAMPLE",
      secretAccessKey: "secret",
      sessionToken: "token",
    });
  });

  it("passes Expiration through so the SDK can refresh", async () => {
    // Without `expiration` the SDK treats the credentials as constant and never
    // calls the provider again — the session would expire mid-life.
    send.mockResolvedValue(credentials());

    const creds = await resolveCredentials(ROLE);

    expect(creds["expiration"]).toEqual(new Date("2030-01-01T00:00:00Z"));
  });

  it("throws when STS returns no usable credentials", async () => {
    send.mockResolvedValue({ Credentials: undefined });

    await expect(resolveCredentials(ROLE)).rejects.toThrow(/no credentials/);
  });

  it("throws when STS omits part of the credentials", async () => {
    send.mockResolvedValue(credentials({ SessionToken: undefined }));

    await expect(resolveCredentials(ROLE)).rejects.toThrow(/no credentials/);
  });

  it("does not assume anything for a target without a role", async () => {
    const { docClient } = await import("../src/lib/dynamo.js");
    docClient("us-east-1");

    expect(send).not.toHaveBeenCalled();
  });
});
