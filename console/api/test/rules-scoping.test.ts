import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { handler } from "../src/handler.js";
import {
  resetTargetsRepository,
  setTargetsRepository,
} from "../src/lib/targets-repository.js";
import {
  resetRulesRepositoryFactory,
  setRulesRepositoryFactory,
} from "../src/lib/rules-repository.js";
import { FakeTargetsRepository } from "./fake-targets-repository.js";
import { FakeRulesRepository } from "./fake-rules-repository.js";

/**
 * Rule operations are scoped to a target (ER-202 criterion 4): an *unknown*
 * target must 404 rather than being indistinguishable from a valid one, and that
 * check must run before the body — or the table — is looked at. Create and update
 * are the half of ER-203 still to come, so they 501 once those checks pass.
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

beforeEach(() => {
  setTargetsRepository(new FakeTargetsRepository([target]));
  setRulesRepositoryFactory(() => new FakeRulesRepository());
});

afterEach(() => {
  resetTargetsRepository();
  resetRulesRepositoryFactory();
});

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

  it("reaches the target's table for a registered target", async () => {
    const res = await handler(event("GET", KNOWN));
    expect(res.statusCode).toBe(200);
    expect(parse(res.body)).toEqual([]);
  });

  it("still 501s on the routes ER-203 has not finished", async () => {
    const res = await handler(event("POST", KNOWN, rule));
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

/**
 * The body carries its own keys, so it can address a different rule than the URL.
 * ER-203 will write `Item: body`, so a mismatch would land the write in a
 * partition the caller never addressed — and a mismatched `sk` on PUT would
 * create a second item rather than replacing the addressed one.
 */
const rule = {
  pk: "www.example.com",
  sk: "REDIRECT#00100",
  type: "erMatchRule",
  statusCode: 301,
  redirectURL: "https://www.example.com/new",
  matches: [{ matchType: "path", matchOperator: "equals", matchValue: "/old" }],
};

describe("rule bodies must address the path they are sent to", () => {
  it("rejects a pk that is not the host in the path", async () => {
    const res = await handler(
      event("POST", KNOWN, { ...rule, pk: "attacker.example.net" }),
    );

    expect(res.statusCode).toBe(400);
    expect(parse(res.body)).toMatchObject({
      error: {
        code: "VALIDATION_ERROR",
        details: [{ path: "/pk" }],
      },
    });
  });

  it("rejects an sk that is not the sort key in the path", async () => {
    const res = await handler(
      event("PUT", `${KNOWN}/REDIRECT%2300100`, {
        ...rule,
        sk: "REDIRECT#00999",
      }),
    );

    expect(res.statusCode).toBe(400);
    expect(parse(res.body)).toMatchObject({
      error: { details: [{ path: "/sk" }] },
    });
  });

  it("reports both keys when both disagree", async () => {
    const res = await handler(
      event("PUT", `${KNOWN}/REDIRECT%2300100`, {
        ...rule,
        pk: "other.example.net",
        sk: "REDIRECT#00999",
      }),
    );

    const details = (parse(res.body) as { error: { details: unknown[] } }).error
      .details;
    expect(details).toHaveLength(2);
  });

  it("accepts a body that matches the path, reaching the stub", async () => {
    // The path param arrives URL-decoded, so REDIRECT%2300100 must compare equal
    // to the body's REDIRECT#00100.
    const res = await handler(event("PUT", `${KNOWN}/REDIRECT%2300100`, rule));

    expect(res.statusCode).toBe(501);
  });

  it("does not compare sk on the collection route", async () => {
    // POST addresses no specific sort key, so only pk is checked.
    const res = await handler(event("POST", KNOWN, rule));

    expect(res.statusCode).toBe(501);
  });
});
