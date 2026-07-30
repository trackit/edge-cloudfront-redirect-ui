import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { handler } from "../src/handler.js";
import {
  resetTargetsRepository,
  setTargetsRepository,
} from "../src/lib/targets-repository.js";
import { FakeTargetsRepository } from "./fake-targets-repository.js";

const event = (
  method: string,
  path: string,
  body?: unknown,
): APIGatewayProxyEventV2 =>
  ({
    rawPath: path,
    headers: {},
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: { http: { method } },
  }) as APIGatewayProxyEventV2;

const parse = (body: string | undefined): unknown =>
  JSON.parse(body ?? "null") as unknown;

const input = { name: "Prod", region: "us-east-1", tableName: "rules-prod" };

const create = async (over: Record<string, unknown> = {}) =>
  parse(
    (await handler(event("POST", "/targets", { ...input, ...over }))).body,
  ) as {
    id: string;
    name: string;
  };

beforeEach(() => setTargetsRepository(new FakeTargetsRepository()));
afterEach(() => resetTargetsRepository());

describe("targets API", () => {
  it("POST /targets creates with a server-generated id", async () => {
    const res = await handler(event("POST", "/targets", input));
    expect(res.statusCode).toBe(201);

    const body = parse(res.body) as { id: string };
    expect(body).toMatchObject(input);
    expect(typeof body.id).toBe("string");
    expect(body.id.length).toBeGreaterThan(0);
  });

  it("POST /targets 400s an unknown region", async () => {
    const res = await handler(
      event("POST", "/targets", { ...input, region: "nope" }),
    );
    expect(res.statusCode).toBe(400);
    expect(parse(res.body)).toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
  });

  it("GET /targets lists sorted by name", async () => {
    // Distinct tables — the same (region, tableName) twice is a 409.
    await create({ name: "Zebra", tableName: "rules-zebra" });
    await create({ name: "Alpha", tableName: "rules-alpha" });

    const res = await handler(event("GET", "/targets"));
    expect(res.statusCode).toBe(200);
    const names = (parse(res.body) as { name: string }[]).map((t) => t.name);
    expect(names).toEqual(["Alpha", "Zebra"]);
  });

  it("GET /targets/:id returns a created target", async () => {
    const created = await create();
    const res = await handler(event("GET", `/targets/${created.id}`));
    expect(res.statusCode).toBe(200);
    expect(parse(res.body)).toEqual(created);
  });

  it("GET /targets/:id 404s an unknown id", async () => {
    const res = await handler(event("GET", "/targets/nope"));
    expect(res.statusCode).toBe(404);
    expect(parse(res.body)).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("PUT /targets/:id updates and keeps the id", async () => {
    const created = await create();
    const res = await handler(
      event("PUT", `/targets/${created.id}`, { ...input, name: "Renamed" }),
    );
    expect(res.statusCode).toBe(200);

    const body = parse(res.body) as { id: string; name: string };
    expect(body.id).toBe(created.id);
    expect(body.name).toBe("Renamed");
  });

  it("PUT /targets/:id 404s an unknown id", async () => {
    const res = await handler(event("PUT", "/targets/nope", input));
    expect(res.statusCode).toBe(404);
  });

  it("DELETE /targets/:id removes it and returns 204", async () => {
    const created = await create();

    const del = await handler(event("DELETE", `/targets/${created.id}`));
    expect(del.statusCode).toBe(204);

    const after = await handler(event("GET", `/targets/${created.id}`));
    expect(after.statusCode).toBe(404);
  });

  it("DELETE /targets/:id 404s an unknown id", async () => {
    const res = await handler(event("DELETE", "/targets/nope"));
    expect(res.statusCode).toBe(404);
  });

  it("POST /targets 409s the same table registered twice", async () => {
    await create();

    // Different name, same (region, tableName) — two entries the UI can't tell
    // apart, both writing to the same data.
    const res = await handler(
      event("POST", "/targets", { ...input, name: "Prod copy" }),
    );
    expect(res.statusCode).toBe(409);
    expect(parse(res.body)).toMatchObject({
      error: { code: "TARGET_EXISTS" },
    });
  });

  it("PUT /targets/:id 409s when repointed at another target's table", async () => {
    const first = await create();
    await create({ name: "Staging", tableName: "rules-staging" });

    const res = await handler(
      event("PUT", `/targets/${first.id}`, {
        ...input,
        tableName: "rules-staging",
      }),
    );
    expect(res.statusCode).toBe(409);
  });

  it("PUT /targets/:id allows keeping its own table", async () => {
    const created = await create();

    // The uniqueness check must exclude the target being updated.
    const res = await handler(
      event("PUT", `/targets/${created.id}`, { ...input, name: "Renamed" }),
    );
    expect(res.statusCode).toBe(200);
  });

  it("POST /targets 400s a whitespace-only name and trims the rest", async () => {
    const blank = await handler(
      event("POST", "/targets", { ...input, name: "   " }),
    );
    expect(blank.statusCode).toBe(400);

    const padded = await handler(
      event("POST", "/targets", {
        ...input,
        name: "  Prod  ",
        tableName: "rules-padded",
      }),
    );
    expect((parse(padded.body) as { name: string }).name).toBe("Prod");
  });

  it("POST /targets allows the same table name in two different accounts", async () => {
    // A table name is only unique within an account, so two accounts following
    // the same naming convention both have rules-prod in us-east-1. Keying the
    // uniqueness check on (region, tableName) alone would 409 the second one —
    // the exact case the per-target role exists to support.
    const first = await handler(
      event("POST", "/targets", {
        ...input,
        roleArn: "arn:aws:iam::111111111111:role/edgeroute-target-prod",
      }),
    );
    expect(first.statusCode).toBe(201);

    const second = await handler(
      event("POST", "/targets", {
        ...input,
        name: "Prod (other account)",
        roleArn: "arn:aws:iam::222222222222:role/edgeroute-target-prod",
      }),
    );
    expect(second.statusCode).toBe(201);
  });

  it("POST /targets still 409s the same table via the same role", async () => {
    const roleArn = "arn:aws:iam::111111111111:role/edgeroute-target-prod";
    await handler(event("POST", "/targets", { ...input, roleArn }));

    const again = await handler(
      event("POST", "/targets", { ...input, name: "Copy", roleArn }),
    );
    expect(again.statusCode).toBe(409);
  });

  it("POST /targets 409s two different roles in the SAME account", async () => {
    // What identifies a table is (account, region, tableName). Two roles in one
    // account granting access to one table are two views of one table, not two
    // targets — keying on the whole ARN would let both through.
    await handler(
      event("POST", "/targets", {
        ...input,
        roleArn: "arn:aws:iam::111111111111:role/role-one",
      }),
    );

    const second = await handler(
      event("POST", "/targets", {
        ...input,
        name: "Same table, other role",
        roleArn: "arn:aws:iam::111111111111:role/role-two",
      }),
    );
    expect(second.statusCode).toBe(409);
  });

  it("POST /targets 409s the same table registered with and without a role", async () => {
    // "No role" means the API's own account, which can't be named without an STS
    // call, so it is treated as clashing with any account — failing closed.
    await handler(event("POST", "/targets", input));

    const second = await handler(
      event("POST", "/targets", {
        ...input,
        name: "Now with a role",
        roleArn: "arn:aws:iam::111111111111:role/edgeroute-target-prod",
      }),
    );
    expect(second.statusCode).toBe(409);
  });

  it("PUT /targets/:id cannot repoint onto another target's table by adding a role", async () => {
    const first = await create();
    const second = await create({
      name: "Staging",
      tableName: "rules-staging",
    });

    const res = await handler(
      event("PUT", `/targets/${second.id}`, {
        ...input,
        name: "Staging",
        roleArn: "arn:aws:iam::111111111111:role/edgeroute-target-prod",
      }),
    );
    expect(res.statusCode).toBe(409);
    expect(first.id).not.toBe(second.id);
  });

  it("POST /targets round-trips an optional roleArn and rejects a bad one", async () => {
    const roleArn = "arn:aws:iam::123456789012:role/edgeroute-target-prod";
    const ok = await handler(event("POST", "/targets", { ...input, roleArn }));
    expect(ok.statusCode).toBe(201);
    expect(parse(ok.body)).toMatchObject({ roleArn });

    const bad = await handler(
      event("POST", "/targets", {
        ...input,
        tableName: "rules-bad-role",
        roleArn: "not-an-arn",
      }),
    );
    expect(bad.statusCode).toBe(400);
  });
});
