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
    await create({ name: "Zebra" });
    await create({ name: "Alpha" });

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
});
