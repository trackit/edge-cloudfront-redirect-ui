import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { handler } from "../src/handler.js";
import {
  resetTargetsRepository,
  setTargetsRepository,
} from "../src/lib/targets-repository.js";
import { FakeTargetsRepository } from "./fake-targets-repository.js";

/**
 * Rule operations are scoped to a target (ER-202 criterion 4). Persistence is
 * ER-203, so a known target still 501s — but an *unknown* target must 404 rather
 * than being indistinguishable from a valid one, and that check must run before
 * the body is looked at.
 */

const target = {
  id: "t1",
  name: "Prod",
  region: "us-east-1",
  tableName: "rules-prod",
};

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

const KNOWN = "/targets/t1/hosts/www.example.com/rules";
const UNKNOWN = "/targets/nope/hosts/www.example.com/rules";

beforeEach(() => setTargetsRepository(new FakeTargetsRepository([target])));
afterEach(() => resetTargetsRepository());

describe("rule routes are scoped to a target", () => {
  const cases: [string, string][] = [
    ["GET", UNKNOWN],
    ["POST", UNKNOWN],
    ["GET", `${UNKNOWN}/REDIRECT%2300100`],
    ["PUT", `${UNKNOWN}/REDIRECT%2300100`],
    ["DELETE", `${UNKNOWN}/REDIRECT%2300100`],
  ];

  it.each(cases)("%s %s 404s an unregistered target", async (method, path) => {
    const res = await handler(event(method, path, { type: "erMatchRule" }));
    expect(res.statusCode).toBe(404);
    expect(parse(res.body)).toMatchObject({
      error: { code: "UNKNOWN_TARGET" },
    });
  });

  it("checks the target before the request body", async () => {
    // A body that would fail validation must still report the unknown target —
    // otherwise a caller can't tell a bad target from a bad rule.
    const res = await handler(event("POST", UNKNOWN, { nonsense: true }));
    expect(res.statusCode).toBe(404);
    expect(parse(res.body)).toMatchObject({
      error: { code: "UNKNOWN_TARGET" },
    });
  });

  it("reaches the not-implemented stub for a registered target", async () => {
    const res = await handler(event("GET", KNOWN));
    expect(res.statusCode).toBe(501);
    expect(parse(res.body)).toMatchObject({
      error: { code: "NOT_IMPLEMENTED" },
    });
  });

  it("still validates the body once the target resolves", async () => {
    const res = await handler(event("POST", KNOWN, { nonsense: true }));
    expect(res.statusCode).toBe(400);
    expect(parse(res.body)).toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
  });
});
