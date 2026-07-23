import { describe, expect, it } from "vitest";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { handler } from "../src/handler.js";

const event = (
  method: string,
  path: string,
  body?: string,
): APIGatewayProxyEventV2 =>
  ({
    rawPath: path,
    headers: {},
    body,
    isBase64Encoded: false,
    requestContext: { http: { method } },
  }) as APIGatewayProxyEventV2;

const parse = (body: string | undefined): unknown =>
  JSON.parse(body ?? "{}") as unknown;

describe("handler", () => {
  it("GET /health returns 200 with status ok", async () => {
    const res = await handler(event("GET", "/health"));

    expect(res.statusCode).toBe(200);
    expect(res.headers?.["content-type"]).toBe("application/json");
    expect(parse(res.body)).toEqual({ status: "ok" });
  });

  it("returns a standardized 404 for an unknown route", async () => {
    const res = await handler(event("GET", "/nope"));

    expect(res.statusCode).toBe(404);
    expect(parse(res.body)).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("returns a 405 when the method is wrong for a known path", async () => {
    const res = await handler(event("DELETE", "/health"));

    expect(res.statusCode).toBe(405);
    expect(parse(res.body)).toMatchObject({
      error: { code: "METHOD_NOT_ALLOWED" },
    });
  });

  it("returns a 400 for a malformed JSON body", async () => {
    const res = await handler(event("POST", "/health", "{not json"));

    expect(res.statusCode).toBe(400);
    expect(parse(res.body)).toMatchObject({ error: { code: "INVALID_JSON" } });
  });
});
