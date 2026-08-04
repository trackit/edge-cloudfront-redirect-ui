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
 * check must run before the body — or the table — is looked at.
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
const UNKNOWN_HOSTS = "/targets/nope/hosts";

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
    ["GET", UNKNOWN_HOSTS],
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

  it("still validates the body once the target resolves", async () => {
    const res = await handler(event("POST", KNOWN, { nonsense: true }));
    expect(res.statusCode).toBe(400);
    expect(parse(res.body)).toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
  });
});

/**
 * The server owns both keys, but a body may still carry them — that is what a
 * rule fetched with GET and PUT back unchanged looks like. They are checked
 * rather than trusted: an unchecked `pk` would land the write in a partition the
 * caller never addressed, and an unchecked `sk` would write a second rule
 * instead of replacing the addressed one.
 */
const rule = {
  pk: "www.example.com",
  sk: "REDIRECT#00100",
  priority: 100,
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

  it("accepts a body whose keys match the path", async () => {
    // The path param arrives URL-decoded, so REDIRECT%2300100 must compare equal
    // to the body's REDIRECT#00100. Nothing is stored yet, so a replace 404s —
    // which is already past every key check.
    const res = await handler(event("PUT", `${KNOWN}/REDIRECT%2300100`, rule));

    expect(res.statusCode).toBe(404);
    expect(parse(res.body)).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("rejects an sk that is not the key the priority implies", async () => {
    // The collection route addresses no existing rule, so a supplied `sk` is
    // checked against the key `priority` derives — here 50, so the fixture's
    // REDIRECT#00100 disagrees. The message has to name that key and not the
    // path, which has none.
    const res = await handler(event("POST", KNOWN, { ...rule, priority: 50 }));

    expect(res.statusCode).toBe(400);
    expect(parse(res.body)).toMatchObject({
      error: {
        code: "VALIDATION_ERROR",
        details: [{ path: "/sk", message: expect.stringContaining("00050") }],
      },
    });
  });

  it("compares sk against the derived key on the collection route", async () => {
    // POST addresses no specific sort key, so the body's `sk` is checked against
    // the one `priority` implies rather than against the path.
    const res = await handler(event("POST", KNOWN, rule));

    expect(res.statusCode).toBe(201);
  });
});
