import { afterEach, describe, expect, it } from "vitest";
import {
  resetTargetsRepository,
  resolveTarget,
  setTargetsRepository,
} from "../src/lib/targets-repository.js";
import { FakeTargetsRepository } from "./fake-targets-repository.js";

const target = {
  id: "t1",
  name: "Prod",
  region: "us-east-1",
  tableName: "rules-prod",
};

afterEach(() => resetTargetsRepository());

describe("resolveTarget", () => {
  it("returns region and tableName for a known target", async () => {
    setTargetsRepository(new FakeTargetsRepository([target]));

    await expect(resolveTarget("t1")).resolves.toEqual({
      region: "us-east-1",
      tableName: "rules-prod",
    });
  });

  it("throws 404 UNKNOWN_TARGET for an unknown id", async () => {
    setTargetsRepository(new FakeTargetsRepository([]));

    await expect(resolveTarget("nope")).rejects.toMatchObject({
      status: 404,
      code: "UNKNOWN_TARGET",
    });
  });
});

describe("FakeTargetsRepository", () => {
  it("round-trips create / get / list / put / delete", async () => {
    const repo = new FakeTargetsRepository();

    await repo.create(target);
    expect(await repo.get("t1")).toEqual(target);
    expect(await repo.list()).toEqual([target]);

    await repo.put({ ...target, name: "Renamed" });
    expect((await repo.get("t1"))?.name).toBe("Renamed");

    await repo.delete("t1");
    expect(await repo.get("t1")).toBeNull();
  });
});
