import { describe, expect, it, vi } from "vitest";
import {
  linkDistribution,
  nextAfterUnlink,
  resolveCurrent,
  toDistribution,
  unlinkDistribution,
  updateDistribution,
  withLinked,
} from "../src/domain/distribution";
import { ApiError } from "../src/api/error";
import type { ApiClient, Target } from "../src/api";
import type { Distribution, DistributionDraft } from "../src/domain/types";

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

const dist = (targetId: string, distributionId = targetId): Distribution => ({
  targetId,
  distributionId,
  tableName: "rules-prod",
  region: "us-east-1",
});

const targetExists = () =>
  new ApiError({
    status: 409,
    code: "TARGET_EXISTS",
    message: 'target "t-1" is already named "E1"',
  });

const clientWith = (targets: {
  create?: () => Promise<Target>;
  list?: () => Promise<Target[]>;
  update?: (id: string, input: unknown) => Promise<Target>;
  remove?: (id: string) => Promise<void>;
}) =>
  ({
    targets: { list: () => Promise.resolve([]), ...targets },
  }) as unknown as ApiClient;

describe("toDistribution", () => {
  it("reads the target's name as the distribution ID and keeps its role", () => {
    expect(
      toDistribution(target({ roleArn: "arn:aws:iam::111111111111:role/r" })),
    ).toEqual({
      targetId: "t-1",
      distributionId: "E1",
      tableName: "rules-prod",
      region: "us-east-1",
      roleArn: "arn:aws:iam::111111111111:role/r",
    });
  });
});

describe("linkDistribution", () => {
  it("registers the distribution under its ID", async () => {
    const create = vi.fn(() => Promise.resolve(target()));

    await expect(
      linkDistribution(draft, clientWith({ create })),
    ).resolves.toMatchObject({ targetId: "t-1", distributionId: "E1" });
    expect(create).toHaveBeenCalledWith({
      name: "E1",
      region: "us-east-1",
      tableName: "rules-prod",
    });
  });

  it("reuses the distribution a teammate already linked to the same table", async () => {
    const client = clientWith({
      create: () => Promise.reject(targetExists()),
      list: () =>
        Promise.resolve([
          target({ id: "t-other", name: "E2" }),
          target({ id: "t-9", name: "e1" }),
        ]),
    });

    await expect(linkDistribution(draft, client)).resolves.toMatchObject({
      targetId: "t-9",
    });
  });

  it("reuses a distribution a teammate linked by its ID when linking its ARN", async () => {
    const client = clientWith({
      create: () => Promise.reject(targetExists()),
      list: () =>
        Promise.resolve([target({ id: "t-9", name: "E1ABCDEFGHIJKL" })]),
    });

    await expect(
      linkDistribution(
        {
          ...draft,
          distributionId:
            "arn:aws:cloudfront::123456789012:distribution/E1ABCDEFGHIJKL",
        },
        client,
      ),
    ).resolves.toMatchObject({ targetId: "t-9" });
  });

  it("keeps the 409 when the distribution is linked to another table", async () => {
    const conflict = targetExists();
    const client = clientWith({
      create: () => Promise.reject(conflict),
      list: () => Promise.resolve([target({ tableName: "rules-staging" })]),
    });

    await expect(linkDistribution(draft, client)).rejects.toBe(conflict);
  });

  it("keeps the 409 when the list does not show it", async () => {
    const conflict = targetExists();
    const client = clientWith({ create: () => Promise.reject(conflict) });

    await expect(linkDistribution(draft, client)).rejects.toBe(conflict);
  });

  it("rethrows any other error without listing", async () => {
    const forbidden = new ApiError({
      status: 403,
      code: "FORBIDDEN",
      message: "Your account has read-only access",
    });
    const list = vi.fn(() => Promise.resolve([]));
    const client = clientWith({
      create: () => Promise.reject(forbidden),
      list,
    });

    await expect(linkDistribution(draft, client)).rejects.toBe(forbidden);
    expect(list).not.toHaveBeenCalled();
  });

  it("sends a function ARN typed for a distribution already linked", async () => {
    const FN = "arn:aws:lambda:us-east-1:123456789012:function:edge";
    const update = vi.fn(() =>
      Promise.resolve(target({ edgeFunctionArn: FN })),
    );
    const client = clientWith({
      create: () => Promise.reject(targetExists()),
      list: () =>
        Promise.resolve([target({ roleArn: "arn:aws:iam::1:role/r" })]),
      update,
    });

    await linkDistribution({ ...draft, edgeFunctionArn: ` ${FN} ` }, client);

    expect(update).toHaveBeenCalledWith("t-1", {
      name: "E1",
      region: "us-east-1",
      tableName: "rules-prod",
      roleArn: "arn:aws:iam::1:role/r",
      edgeFunctionArn: FN,
    });
  });
});

describe("updateDistribution", () => {
  it("replaces the target, sending back the fields the form does not edit", async () => {
    const update = vi.fn(() => Promise.resolve(target({ name: "E9" })));
    const current: Distribution = {
      ...dist("t-1", "E1"),
      roleArn: "arn:aws:iam::1:role/r",
      edgeFunctionArn: "arn:aws:lambda:us-east-1:1:function:edge",
    };

    await updateDistribution(
      current,
      {
        ...draft,
        distributionId: "E9",
        edgeFunctionArn: "arn:aws:lambda:us-east-1:1:function:edge",
      },
      clientWith({ update }),
    );

    expect(update).toHaveBeenCalledWith("t-1", {
      name: "E9",
      region: "us-east-1",
      tableName: "rules-prod",
      roleArn: "arn:aws:iam::1:role/r",
      edgeFunctionArn: "arn:aws:lambda:us-east-1:1:function:edge",
    });
  });

  it("sends the function ARN typed in the form, and none when it was cleared", async () => {
    const update = vi.fn(() => Promise.resolve(target()));
    const current: Distribution = {
      ...dist("t-1", "E1"),
      edgeFunctionArn: "arn:aws:lambda:us-east-1:1:function:old",
    };

    await updateDistribution(
      current,
      {
        ...draft,
        edgeFunctionArn: " arn:aws:lambda:us-east-1:1:function:new ",
      },
      clientWith({ update }),
    );
    expect(update).toHaveBeenLastCalledWith(
      "t-1",
      expect.objectContaining({
        edgeFunctionArn: "arn:aws:lambda:us-east-1:1:function:new",
      }),
    );

    await updateDistribution(
      current,
      { ...draft, edgeFunctionArn: "" },
      clientWith({ update }),
    );
    expect(update).toHaveBeenLastCalledWith("t-1", {
      name: "E1",
      region: "us-east-1",
      tableName: "rules-prod",
    });
  });
});

describe("unlinkDistribution", () => {
  it("deletes the target", async () => {
    const remove = vi.fn(() => Promise.resolve());
    await unlinkDistribution(dist("t-1"), clientWith({ remove }));
    expect(remove).toHaveBeenCalledWith("t-1");
  });

  it("treats a distribution a teammate already unlinked as done", async () => {
    const client = clientWith({
      remove: () =>
        Promise.reject(
          new ApiError({ status: 404, code: "NOT_FOUND", message: "gone" }),
        ),
    });
    await expect(unlinkDistribution(dist("t-1"), client)).resolves.toBe(
      undefined,
    );
  });

  it("rethrows a refusal", async () => {
    const forbidden = new ApiError({
      status: 403,
      code: "FORBIDDEN",
      message: "Your account has read-only access",
    });
    const client = clientWith({ remove: () => Promise.reject(forbidden) });
    await expect(unlinkDistribution(dist("t-1"), client)).rejects.toBe(
      forbidden,
    );
  });
});

describe("resolveCurrent", () => {
  const list = [dist("a"), dist("b")];

  it("is the selected distribution", () => {
    expect(resolveCurrent(list, "b")?.targetId).toBe("b");
  });

  it("falls back to the first when the selection was unlinked or never made", () => {
    expect(resolveCurrent(list, "gone")?.targetId).toBe("a");
    expect(resolveCurrent(list, null)?.targetId).toBe("a");
  });

  it("is none when the team has no distribution", () => {
    expect(resolveCurrent([], "a")).toBeNull();
  });
});

describe("nextAfterUnlink", () => {
  const list = [dist("a"), dist("b"), dist("c")];

  it("moves to the next distribution", () => {
    expect(nextAfterUnlink(list, "a")).toBe("b");
    expect(nextAfterUnlink(list, "b")).toBe("c");
  });

  it("moves to the previous one when the last is unlinked", () => {
    expect(nextAfterUnlink(list, "c")).toBe("b");
  });

  it("is none when it was the only one", () => {
    expect(nextAfterUnlink([dist("a")], "a")).toBeNull();
  });
});

describe("withLinked", () => {
  it("appends a new distribution", () => {
    expect(withLinked([dist("a")], dist("b")).map((d) => d.targetId)).toEqual([
      "a",
      "b",
    ]);
  });

  it("replaces the entry of a distribution already listed, in place", () => {
    const next = withLinked([dist("a"), dist("b")], dist("a", "E-renamed"));
    expect(next.map((d) => d.distributionId)).toEqual(["E-renamed", "b"]);
  });
});
