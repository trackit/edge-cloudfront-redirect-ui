import { describe, expect, it, vi } from "vitest";
import { connectDistribution } from "../src/domain/distribution";
import { ApiError } from "../src/api/error";
import type { ApiClient, Target } from "../src/api";
import type { DistributionDraft } from "../src/domain/types";

/**
 * The connect flow's 409 fallback.
 *
 * Registering a table that is already in the registry is a 409, and that is a
 * *success* for what the user asked for ("point me at this table") — someone
 * else connected it, or this browser cleared its storage. Getting this wrong
 * means an operator who reinstalls their browser can never reconnect.
 */

const draft: DistributionDraft = {
  distributionId: "E1",
  tableName: "rules-prod",
  region: "us-east-1",
};

const target = (over: Partial<Target> = {}): Target => ({
  id: "t-1",
  name: "E1",
  region: "us-east-1",
  tableName: "rules-prod",
  ...over,
});

const targetExists = () =>
  new ApiError({
    status: 409,
    code: "TARGET_EXISTS",
    message: 'target "t-1" already registers table "rules-prod"',
  });

/** Only the two methods this flow touches; the rest would be dead weight. */
const clientWith = (targets: {
  create: () => Promise<Target>;
  list?: () => Promise<Target[]>;
}) =>
  ({
    targets: { list: () => Promise.resolve([]), ...targets },
  }) as unknown as ApiClient;

describe("connectDistribution", () => {
  it("registers the table and carries the target id back", async () => {
    const create = vi.fn(() => Promise.resolve(target()));
    const client = clientWith({ create });

    await expect(connectDistribution(draft, client)).resolves.toEqual({
      ...draft,
      targetId: "t-1",
    });

    // The distribution ID doubles as the target's name — the API requires one
    // and the connect form collects none.
    expect(create).toHaveBeenCalledWith({
      name: "E1",
      region: "us-east-1",
      tableName: "rules-prod",
    });
  });

  it("reuses the existing target when the table is already registered", async () => {
    const client = clientWith({
      create: () => Promise.reject(targetExists()),
      list: () =>
        Promise.resolve([
          target({ id: "t-other", tableName: "rules-staging" }),
          target({ id: "t-9", name: "connected by someone else" }),
        ]),
    });

    // Matched on (region, tableName), which is what the registry dedupes on —
    // not on the name, which is this browser's idea of the distribution.
    await expect(connectDistribution(draft, client)).resolves.toEqual({
      ...draft,
      targetId: "t-9",
    });
  });

  it("matches on region as well as table name", async () => {
    const client = clientWith({
      create: () => Promise.reject(targetExists()),
      list: () =>
        Promise.resolve([target({ id: "t-eu", region: "eu-west-1" })]),
    });

    // Same table name in another region is a different table, so there is
    // nothing to reuse and the 409 stands.
    await expect(connectDistribution(draft, client)).rejects.toMatchObject({
      code: "TARGET_EXISTS",
    });
  });

  it("rethrows the original 409 when the list does not show it", async () => {
    const conflict = targetExists();
    const client = clientWith({
      create: () => Promise.reject(conflict),
      list: () => Promise.resolve([]),
    });

    // Inventing a reason here would send the user looking for a target that is
    // not there; the server's own refusal is the more truthful answer.
    await expect(connectDistribution(draft, client)).rejects.toBe(conflict);
  });

  it("rethrows any other API error untouched", async () => {
    const validation = new ApiError({
      status: 400,
      code: "VALIDATION_ERROR",
      message: "Target failed validation",
      details: [{ path: "/tableName", message: "no such table" }],
    });
    const list = vi.fn(() => Promise.resolve([]));
    const client = clientWith({
      create: () => Promise.reject(validation),
      list,
    });

    await expect(connectDistribution(draft, client)).rejects.toBe(validation);
    // No point listing targets for a body the server rejected.
    expect(list).not.toHaveBeenCalled();
  });

  it("rethrows a failure that is not an ApiError", async () => {
    const bug = new TypeError("client is not a function");
    const client = clientWith({ create: () => Promise.reject(bug) });

    await expect(connectDistribution(draft, client)).rejects.toBe(bug);
  });
});
