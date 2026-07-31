import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { handler } from "../src/handler.js";
import {
  resetTargetsRepository,
  setTargetsRepository,
  type ResolvedTarget,
} from "../src/lib/targets-repository.js";
import {
  resetRulesRepositoryFactory,
  setRulesRepositoryFactory,
  type RuleItem,
} from "../src/lib/rules-repository.js";
import { FakeTargetsRepository } from "./fake-targets-repository.js";
import { FakeRulesRepository } from "./fake-rules-repository.js";

/**
 * Rule reads and deletes end to end, through the real router and handler over an
 * in-memory rules table (ER-203, first half). Create and update are still stubs
 * — rules-scoping.test.ts owns what they answer.
 */

const target = {
  id: "t1",
  name: "Prod",
  region: "eu-west-1",
  tableName: "rules-prod",
  roleArn: "arn:aws:iam::123456789012:role/edgeroute-target-prod",
};

const HOST = "www.example.com";
const BASE = `/targets/t1/hosts/${HOST}/rules`;

const redirect = (priority: string): RuleItem => ({
  pk: HOST,
  sk: `REDIRECT#${priority}`,
  type: "erMatchRule",
  statusCode: 301,
  redirectURL: `https://www.example.com/${priority}`,
  matches: [{ matchType: "path", matchOperator: "equals", matchValue: "/old" }],
});

const rewrite = (priority: string): RuleItem => ({
  pk: HOST,
  sk: `REWRITE#${priority}`,
  type: "frMatchRule",
  matches: [{ matchType: "path", matchOperator: "equals", matchValue: "/app" }],
  forwardSettings: { pathAndQS: "/app/index.html" },
});

const event = (method: string, path: string): APIGatewayProxyEventV2 =>
  ({
    rawPath: path,
    headers: {},
    isBase64Encoded: false,
    requestContext: { http: { method } },
  }) as APIGatewayProxyEventV2;

const parse = (body: string | undefined): unknown =>
  JSON.parse(body ?? "null") as unknown;

/** Installs a rules table and reports which target the API asked it for. */
const seed = (items: RuleItem[]): { asked: ResolvedTarget[] } => {
  const asked: ResolvedTarget[] = [];
  const repo = new FakeRulesRepository(items);

  setRulesRepositoryFactory((resolved) => {
    asked.push(resolved);
    return repo;
  });

  return { asked };
};

beforeEach(() => setTargetsRepository(new FakeTargetsRepository([target])));

afterEach(() => {
  resetTargetsRepository();
  resetRulesRepositoryFactory();
});

describe("GET rules", () => {
  it("returns the host's rules in sort-key order", async () => {
    // Seeded out of order, and interleaved across kinds: REDIRECT#00900 must
    // still precede REWRITE#00100, because the edge evaluates the two kinds in
    // separate phases rather than as one priority-ordered list.
    seed([rewrite("00100"), redirect("00900"), redirect("00100")]);

    const res = await handler(event("GET", BASE));

    expect(res.statusCode).toBe(200);
    expect((parse(res.body) as RuleItem[]).map((r) => r.sk)).toEqual([
      "REDIRECT#00100",
      "REDIRECT#00900",
      "REWRITE#00100",
    ]);
  });

  it("returns an empty array for a host with no rules", async () => {
    seed([]);

    const res = await handler(event("GET", BASE));

    expect(res.statusCode).toBe(200);
    expect(parse(res.body)).toEqual([]);
  });

  it("does not leak another host's rules", async () => {
    seed([
      redirect("00100"),
      { ...redirect("00100"), pk: "other.example.net" },
    ]);

    const res = await handler(event("GET", BASE));

    expect(parse(res.body)).toEqual([redirect("00100")]);
  });

  it("serves each target from its own table", async () => {
    // The console points at many tables from one deployment, so the routes must
    // not answer target t2 out of t1's rules.
    setTargetsRepository(
      new FakeTargetsRepository([
        target,
        {
          id: "t2",
          name: "Staging",
          region: "us-east-1",
          tableName: "rules-stg",
        },
      ]),
    );

    const tables: Record<string, FakeRulesRepository> = {
      "rules-prod": new FakeRulesRepository([redirect("00100")]),
      "rules-stg": new FakeRulesRepository([rewrite("00500")]),
    };
    setRulesRepositoryFactory((resolved) => tables[resolved.tableName]!);

    const prod = await handler(event("GET", BASE));
    const staging = await handler(
      event("GET", `/targets/t2/hosts/${HOST}/rules`),
    );

    expect((parse(prod.body) as RuleItem[]).map((r) => r.sk)).toEqual([
      "REDIRECT#00100",
    ]);
    expect((parse(staging.body) as RuleItem[]).map((r) => r.sk)).toEqual([
      "REWRITE#00500",
    ]);
  });

  it("reaches the table through the target's own coordinates", async () => {
    // Rules live in the target's table under the target's role — not in the
    // control plane's own region or credentials.
    const { asked } = seed([]);

    await handler(event("GET", BASE));

    expect(asked).toEqual([
      {
        region: "eu-west-1",
        tableName: "rules-prod",
        roleArn: "arn:aws:iam::123456789012:role/edgeroute-target-prod",
      },
    ]);
  });
});

describe("GET a single rule", () => {
  it("returns the rule as stored", async () => {
    seed([redirect("00100")]);

    const res = await handler(event("GET", `${BASE}/REDIRECT%2300100`));

    expect(res.statusCode).toBe(200);
    // The exact item the Lambda@Edge reads — no field the API added on the way
    // out, or the response would no longer validate against the shared schema.
    expect(parse(res.body)).toEqual(redirect("00100"));
  });

  it("404s a rule that does not exist", async () => {
    seed([redirect("00100")]);

    const res = await handler(event("GET", `${BASE}/REDIRECT%2300200`));

    expect(res.statusCode).toBe(404);
    expect(parse(res.body)).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("400s a malformed rule id without touching the table", async () => {
    // `sk` is half the primary key, so a malformed one addresses no item the API
    // could have written — a DynamoDB round-trip that can only miss.
    const { asked } = seed([redirect("00100")]);

    const res = await handler(event("GET", `${BASE}/REDIRECT%23100`));

    expect(res.statusCode).toBe(400);
    expect(parse(res.body)).toMatchObject({ error: { code: "BAD_REQUEST" } });
    expect(asked).toEqual([]);
  });

  it("reports an unknown target ahead of a malformed rule id", async () => {
    seed([]);

    const res = await handler(
      event("GET", "/targets/nope/hosts/www.example.com/rules/bad-id"),
    );

    expect(res.statusCode).toBe(404);
    expect(parse(res.body)).toMatchObject({
      error: { code: "UNKNOWN_TARGET" },
    });
  });
});

describe("DELETE a rule", () => {
  it("removes the rule and answers 204", async () => {
    seed([redirect("00100"), redirect("00200")]);

    const res = await handler(event("DELETE", `${BASE}/REDIRECT%2300100`));

    expect(res.statusCode).toBe(204);

    const left = await handler(event("GET", BASE));
    expect((parse(left.body) as RuleItem[]).map((r) => r.sk)).toEqual([
      "REDIRECT#00200",
    ]);
  });

  it("404s a rule that does not exist", async () => {
    // DeleteItem is idempotent on its own; the conditional write is what makes
    // this a 404 instead of a 204 claiming to have removed something.
    seed([]);

    const res = await handler(event("DELETE", `${BASE}/REDIRECT%2300100`));

    expect(res.statusCode).toBe(404);
    expect(parse(res.body)).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("400s a malformed rule id", async () => {
    seed([]);

    const res = await handler(event("DELETE", `${BASE}/nonsense`));

    expect(res.statusCode).toBe(400);
    expect(parse(res.body)).toMatchObject({ error: { code: "BAD_REQUEST" } });
  });
});
