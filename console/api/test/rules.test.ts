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
 * Rule CRUD end to end, through the real router and handler over an in-memory
 * rules table. The `disabled` toggle is the one route not here yet.
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

/** A rule body with one field left out, for the "omitted" cases. */
const without = (
  body: Record<string, unknown>,
  field: string,
): Record<string, unknown> => {
  const copy = { ...body };
  delete copy[field];
  return copy;
};

/** What a client sends: the rule's fields plus a priority, and no keys. */
const input = (priority: number, overrides: Record<string, unknown> = {}) => ({
  priority,
  type: "erMatchRule",
  statusCode: 301,
  redirectURL: `https://www.example.com/${priority}`,
  matches: [{ matchType: "path", matchOperator: "equals", matchValue: "/old" }],
  ...overrides,
});

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

describe("POST a rule", () => {
  it("builds the keys and returns the stored item", async () => {
    seed([]);

    const res = await handler(event("POST", BASE, input(100)));

    expect(res.statusCode).toBe(201);
    // `priority` is gone and the keys are the server's: the response is exactly
    // what the edge will read, which is also why it still validates as a Rule.
    expect(parse(res.body)).toEqual({
      pk: HOST,
      sk: "REDIRECT#00100",
      type: "erMatchRule",
      statusCode: 301,
      redirectURL: "https://www.example.com/100",
      matches: [
        { matchType: "path", matchOperator: "equals", matchValue: "/old" },
      ],
    });

    const listed = await handler(event("GET", BASE));
    expect((parse(listed.body) as RuleItem[]).map((r) => r.sk)).toEqual([
      "REDIRECT#00100",
    ]);
  });

  it("zero-pads the priority into the sort key", async () => {
    seed([]);

    const res = await handler(event("POST", BASE, input(7)));

    expect((parse(res.body) as RuleItem).sk).toBe("REDIRECT#00007");
  });

  it("keys a rewrite under REWRITE", async () => {
    seed([]);

    const res = await handler(
      event("POST", BASE, {
        priority: 100,
        type: "frMatchRule",
        matches: [
          { matchType: "path", matchOperator: "equals", matchValue: "/app" },
        ],
        forwardSettings: { pathAndQS: "/app/index.html" },
      }),
    );

    expect(res.statusCode).toBe(201);
    expect((parse(res.body) as RuleItem).sk).toBe("REWRITE#00100");
  });

  it("409s rather than overwriting the rule at that priority", async () => {
    // A plain Put would replace it: the author would see their new rule and the
    // old one would simply be gone.
    seed([redirect("00100")]);

    const res = await handler(
      event("POST", BASE, input(100, { redirectURL: "https://elsewhere/" })),
    );

    expect(res.statusCode).toBe(409);
    expect(parse(res.body)).toMatchObject({ error: { code: "RULE_EXISTS" } });

    const kept = await handler(event("GET", `${BASE}/REDIRECT%2300100`));
    expect(parse(kept.body)).toEqual(redirect("00100"));
  });

  it("lets the same priority exist for each rule type", async () => {
    // The type is part of the key, so REDIRECT#00100 and REWRITE#00100 are two
    // different rules evaluated in two different phases at the edge.
    seed([rewrite("00100")]);

    const res = await handler(event("POST", BASE, input(100)));

    expect(res.statusCode).toBe(201);
  });

  it("400s a body with no priority", async () => {
    seed([]);

    const res = await handler(
      event("POST", BASE, without(input(100), "priority")),
    );

    expect(res.statusCode).toBe(400);
    expect(parse(res.body)).toMatchObject({
      error: { code: "VALIDATION_ERROR", details: [{ path: "/priority" }] },
    });
  });

  it("400s a priority the sort key cannot represent", async () => {
    seed([]);

    const res = await handler(event("POST", BASE, input(100000)));

    expect(res.statusCode).toBe(400);
    expect(parse(res.body)).toMatchObject({
      error: { code: "VALIDATION_ERROR", details: [{ path: "/priority" }] },
    });
  });

  it("400s a rule that fails the shared schema", async () => {
    seed([]);

    const res = await handler(
      event("POST", BASE, input(100, { statusCode: 418 })),
    );

    expect(res.statusCode).toBe(400);
    expect(parse(res.body)).toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
  });
});

describe("PATCH a rule's disabled flag", () => {
  const AT_100 = `${BASE}/REDIRECT%2300100`;

  it("disables the rule and returns it as stored", async () => {
    seed([redirect("00100")]);

    const res = await handler(event("PATCH", AT_100, { disabled: true }));

    expect(res.statusCode).toBe(200);
    expect(parse(res.body)).toEqual({ ...redirect("00100"), disabled: true });
  });

  it("re-enables it", async () => {
    seed([{ ...redirect("00100"), disabled: true }]);

    const res = await handler(event("PATCH", AT_100, { disabled: false }));

    expect(res.statusCode).toBe(200);
    expect((parse(res.body) as RuleItem).disabled).toBe(false);
  });

  it("leaves the rule where it is, and the rest of it alone", async () => {
    // A disabled rule keeps its priority — it is out of service, not moved or
    // rewritten, so the author can put it back exactly as it was.
    seed([redirect("00100")]);

    await handler(event("PATCH", AT_100, { disabled: true }));
    const listed = await handler(event("GET", BASE));

    expect(parse(listed.body)).toEqual([
      { ...redirect("00100"), disabled: true },
    ]);
  });

  it("404s a rule that does not exist", async () => {
    seed([]);

    const res = await handler(event("PATCH", AT_100, { disabled: true }));

    expect(res.statusCode).toBe(404);
    expect(parse(res.body)).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("400s a malformed rule id", async () => {
    seed([]);

    const res = await handler(
      event("PATCH", `${BASE}/nonsense`, { disabled: true }),
    );

    expect(res.statusCode).toBe(400);
    expect(parse(res.body)).toMatchObject({ error: { code: "BAD_REQUEST" } });
  });

  const badBodies: [string, unknown][] = [
    ["a missing disabled", {}],
    ["a non-boolean disabled", { disabled: "true" }],
    ["a null body", null],
    ["an array", [{ disabled: true }]],
  ];

  it.each(badBodies)("400s %s", async (_label, body) => {
    seed([redirect("00100")]);

    const res = await handler(event("PATCH", AT_100, body));

    expect(res.statusCode).toBe(400);
    expect(parse(res.body)).toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
  });

  it("400s any other field rather than ignoring it", async () => {
    // Silently dropping it would let a client believe it had edited a rule it
    // had only toggled.
    seed([redirect("00100")]);

    const res = await handler(
      event("PATCH", AT_100, { disabled: true, statusCode: 302 }),
    );

    expect(res.statusCode).toBe(400);
    expect(parse(res.body)).toMatchObject({
      error: {
        code: "VALIDATION_ERROR",
        details: [{ path: "/statusCode" }],
      },
    });

    const untouched = await handler(event("GET", AT_100));
    expect(parse(untouched.body)).toEqual(redirect("00100"));
  });
});

describe("PUT a rule", () => {
  const AT_100 = `${BASE}/REDIRECT%2300100`;

  it("replaces the rule in place", async () => {
    seed([redirect("00100")]);

    const res = await handler(
      event("PUT", AT_100, input(100, { redirectURL: "https://new/" })),
    );

    expect(res.statusCode).toBe(200);
    expect(parse(res.body)).toMatchObject({
      sk: "REDIRECT#00100",
      redirectURL: "https://new/",
    });
  });

  it("400s a body with no priority, like create", async () => {
    // PUT is a full replace — every other omitted field is cleared — so an
    // omitted priority cannot quietly mean "leave it where it is".
    seed([redirect("00100")]);

    const res = await handler(
      event("PUT", AT_100, without(input(100), "priority")),
    );

    expect(res.statusCode).toBe(400);
    expect(parse(res.body)).toMatchObject({
      error: { code: "VALIDATION_ERROR", details: [{ path: "/priority" }] },
    });
  });

  it("accepts the sk of the rule being replaced while moving it", async () => {
    // A client that echoes the fetched rule's `sk` back is naming the rule it is
    // replacing, not where the new priority puts it.
    seed([redirect("00100")]);

    const res = await handler(
      event("PUT", AT_100, input(50, { sk: "REDIRECT#00100" })),
    );

    expect(res.statusCode).toBe(200);
    expect((parse(res.body) as RuleItem).sk).toBe("REDIRECT#00050");
  });

  it("404s a rule that does not exist rather than creating it", async () => {
    seed([]);

    const res = await handler(event("PUT", AT_100, input(100)));

    expect(res.statusCode).toBe(404);
    const listed = await handler(event("GET", BASE));
    expect(parse(listed.body)).toEqual([]);
  });

  it("moves the rule when the priority changes", async () => {
    seed([redirect("00100")]);

    const res = await handler(event("PUT", AT_100, input(50)));

    expect(res.statusCode).toBe(200);
    expect((parse(res.body) as RuleItem).sk).toBe("REDIRECT#00050");

    // Exactly one rule afterwards: live at both priorities would mean two rules
    // matching the same request at the edge.
    const listed = await handler(event("GET", BASE));
    expect((parse(listed.body) as RuleItem[]).map((r) => r.sk)).toEqual([
      "REDIRECT#00050",
    ]);
  });

  it("409s a move onto a priority already taken, touching neither rule", async () => {
    seed([redirect("00100"), redirect("00200")]);

    const res = await handler(event("PUT", AT_100, input(200)));

    expect(res.statusCode).toBe(409);
    expect(parse(res.body)).toMatchObject({ error: { code: "RULE_EXISTS" } });

    const listed = await handler(event("GET", BASE));
    expect(parse(listed.body)).toEqual([redirect("00100"), redirect("00200")]);
  });

  it("404s a move whose source is gone", async () => {
    seed([]);

    const res = await handler(event("PUT", AT_100, input(50)));

    expect(res.statusCode).toBe(404);
    const listed = await handler(event("GET", BASE));
    expect(parse(listed.body)).toEqual([]);
  });

  it("moves a rule across types when the type changes", async () => {
    // The type is half the key, so this is a move too — not an update in place
    // that would leave the redirect behind.
    seed([redirect("00100")]);

    const res = await handler(
      event("PUT", AT_100, {
        priority: 100,
        type: "frMatchRule",
        matches: [
          { matchType: "path", matchOperator: "equals", matchValue: "/app" },
        ],
        forwardSettings: { pathAndQS: "/app/index.html" },
      }),
    );

    expect(res.statusCode).toBe(200);
    const listed = await handler(event("GET", BASE));
    expect((parse(listed.body) as RuleItem[]).map((r) => r.sk)).toEqual([
      "REWRITE#00100",
    ]);
  });

  it("400s a malformed rule id before reading the body", async () => {
    const { asked } = seed([]);

    const res = await handler(event("PUT", `${BASE}/nonsense`, input(100)));

    expect(res.statusCode).toBe(400);
    expect(parse(res.body)).toMatchObject({ error: { code: "BAD_REQUEST" } });
    expect(asked).toEqual([]);
  });
});
