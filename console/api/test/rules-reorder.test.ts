import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { EDITOR, VIEWER } from "./principal-claims.js";
import { handler } from "../src/handler.js";
import {
  resetTargetsRepository,
  setTargetsRepository,
} from "../src/lib/targets-repository.js";
import {
  resetRulesRepositoryFactory,
  setRulesRepositoryFactory,
  type RuleItem,
} from "../src/lib/rules-repository.js";
import { FakeTargetsRepository } from "./fake-targets-repository.js";
import { FakeRulesRepository } from "./fake-rules-repository.js";

/**
 * `POST …/rules/reorder`, through the real router over an in-memory rules table
 * — the drag & drop save (CF-31).
 *
 * The priority arithmetic is covered in rule-order.test.ts; what these cases add
 * is the route itself: that the table really ends up reordered, that the other
 * kind and the host marker are left alone, and who is allowed to ask.
 */

const target = {
  id: "t1",
  name: "Prod",
  region: "eu-west-1",
  tableName: "rules-prod",
};

const HOST = "www.example.com";
const BASE = `/targets/t1/hosts/${HOST}/rules`;
const REORDER = `${BASE}/reorder`;

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

const event = (
  path: string,
  body?: unknown,
  claims: object = EDITOR,
): APIGatewayProxyEventV2 =>
  ({
    rawPath: path,
    headers: {},
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: { http: { method: "POST" }, ...claims },
  }) as unknown as APIGatewayProxyEventV2;

const parse = (body: string | undefined): unknown =>
  JSON.parse(body ?? "null") as unknown;

const keysOf = (body: string | undefined): string[] =>
  (parse(body) as RuleItem[]).map((rule) => rule.sk);

/** The rules as the table holds them now, in key order. */
const stored = async (repo: FakeRulesRepository): Promise<RuleItem[]> =>
  (await repo.listByHost(HOST)).sort((a, b) => a.sk.localeCompare(b.sk));

let repo: FakeRulesRepository;

const seed = (items: RuleItem[]): FakeRulesRepository => {
  repo = new FakeRulesRepository(items);
  setRulesRepositoryFactory(() => repo);
  return repo;
};

beforeEach(() => setTargetsRepository(new FakeTargetsRepository([target])));

afterEach(() => {
  resetTargetsRepository();
  resetRulesRepositoryFactory();
});

describe("POST rules/reorder", () => {
  const order = (...keys: string[]) => ({ type: "erMatchRule", order: keys });

  it("returns the rules in their new order, on the same priorities", async () => {
    seed([redirect("00100"), redirect("00200"), redirect("00300")]);

    const res = await handler(
      event(
        REORDER,
        order("REDIRECT#00300", "REDIRECT#00100", "REDIRECT#00200"),
      ),
    );

    expect(res.statusCode).toBe(200);
    expect(keysOf(res.body)).toEqual([
      "REDIRECT#00100",
      "REDIRECT#00200",
      "REDIRECT#00300",
    ]);
    // Which rule sits on each priority is the part that changed: the rule that
    // was last is now first, and it answers on the first rule's old key.
    expect((parse(res.body) as RuleItem[])[0]?.redirectURL).toBe(
      "https://www.example.com/00300",
    );
  });

  it("leaves the table in that order", async () => {
    // The response could be right while the writes were not — this is the case
    // that would catch a plan that was computed and never applied.
    const table = seed([redirect("00100"), redirect("00200")]);

    await handler(event(REORDER, order("REDIRECT#00200", "REDIRECT#00100")));

    expect((await stored(table)).map((rule) => rule.redirectURL)).toEqual([
      "https://www.example.com/00200",
      "https://www.example.com/00100",
    ]);
  });

  it("neither creates nor deletes a rule", async () => {
    const table = seed([redirect("00100"), redirect("00200")]);

    await handler(event(REORDER, order("REDIRECT#00200", "REDIRECT#00100")));

    expect((await stored(table)).map((rule) => rule.sk)).toEqual([
      "REDIRECT#00100",
      "REDIRECT#00200",
    ]);
  });

  it("does not touch the other kind", async () => {
    // Redirects and rewrites are separate sequences at the edge, and a reorder
    // of one must not renumber the other.
    const table = seed([
      redirect("00100"),
      redirect("00200"),
      rewrite("00100"),
      rewrite("00900"),
    ]);

    const res = await handler(
      event(REORDER, order("REDIRECT#00200", "REDIRECT#00100")),
    );

    expect(keysOf(res.body)).toEqual(["REDIRECT#00100", "REDIRECT#00200"]);
    const rewrites = (await stored(table)).filter(
      (rule) => rule.type === "frMatchRule",
    );
    expect(rewrites.map((rule) => rule.redirectURL)).toEqual([
      undefined,
      undefined,
    ]);
    expect(rewrites.map((rule) => rule.sk)).toEqual([
      "REWRITE#00100",
      "REWRITE#00900",
    ]);
  });

  it("reorders the rewrites when asked for them", async () => {
    const table = seed([rewrite("00100"), rewrite("00900")]);

    const res = await handler(
      event(REORDER, {
        type: "frMatchRule",
        order: ["REWRITE#00900", "REWRITE#00100"],
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(keysOf(res.body)).toEqual(["REWRITE#00100", "REWRITE#00900"]);
    expect((await stored(table)).map((rule) => rule.sk)).toEqual([
      "REWRITE#00100",
      "REWRITE#00900",
    ]);
  });

  it("counts the host marker as neither a rule nor a gap", async () => {
    // The marker shares the partition. Read as a rule it would make every order
    // look incomplete, and a reorder of a host that has one would always 409.
    const table = seed([redirect("00100"), redirect("00200")]);
    await table.createHost(HOST);

    const res = await handler(
      event(REORDER, order("REDIRECT#00200", "REDIRECT#00100")),
    );

    expect(res.statusCode).toBe(200);
  });

  it("groups a rule by its key, not by the type field on the item", async () => {
    // The two always agree for anything this API wrote — the key's prefix is
    // derived from the type. For anything else, the prefix is what the edge
    // queries on, and a rule listed among the redirects has to be reorderable
    // with them rather than silently left out of every order.
    const table = seed([
      redirect("00100"),
      { ...redirect("00200"), type: "frMatchRule" },
    ]);

    const res = await handler(
      event(REORDER, order("REDIRECT#00200", "REDIRECT#00100")),
    );

    expect(res.statusCode).toBe(200);
    expect((await stored(table)).map((rule) => rule.type)).toEqual([
      "frMatchRule",
      "erMatchRule",
    ]);
  });

  it("accepts the order the rules are already in, writing nothing", async () => {
    const table = seed([redirect("00100"), redirect("00200")]);
    const before = await stored(table);

    const res = await handler(
      event(REORDER, order("REDIRECT#00100", "REDIRECT#00200")),
    );

    expect(res.statusCode).toBe(200);
    expect(await stored(table)).toEqual(before);
  });

  it("is a 409 when a rule was created after the client read the list", async () => {
    seed([redirect("00100"), redirect("00200"), redirect("00300")]);

    const res = await handler(
      event(REORDER, order("REDIRECT#00200", "REDIRECT#00100")),
    );

    expect(res.statusCode).toBe(409);
    expect(parse(res.body)).toMatchObject({
      error: { code: "RULES_CHANGED" },
    });
  });

  it("is a 409 when a rule in the order has since been deleted", async () => {
    seed([redirect("00100"), redirect("00200")]);

    const res = await handler(
      event(
        REORDER,
        order("REDIRECT#00300", "REDIRECT#00200", "REDIRECT#00100"),
      ),
    );

    expect(res.statusCode).toBe(409);
  });

  it("writes nothing when it refuses", async () => {
    const table = seed([
      redirect("00100"),
      redirect("00200"),
      redirect("00300"),
    ]);
    const before = await stored(table);

    await handler(event(REORDER, order("REDIRECT#00200", "REDIRECT#00100")));

    expect(await stored(table)).toEqual(before);
  });

  it("is a 400 for a key of the wrong kind", async () => {
    seed([redirect("00100"), rewrite("00100")]);

    const res = await handler(
      event(REORDER, order("REDIRECT#00100", "REWRITE#00100")),
    );

    expect(res.statusCode).toBe(400);
    expect(parse(res.body)).toMatchObject({
      error: { code: "VALIDATION_ERROR", details: [{ path: "/order/1" }] },
    });
  });

  it("is a 400 with no body at all", async () => {
    seed([redirect("00100")]);

    expect((await handler(event(REORDER))).statusCode).toBe(400);
  });

  it("is a 404 for a target that is not registered", async () => {
    seed([redirect("00100")]);

    const res = await handler(
      event(
        `/targets/nope/hosts/${HOST}/rules/reorder`,
        order("REDIRECT#00100"),
      ),
    );

    expect(res.statusCode).toBe(404);
  });

  it("is a 409 for a host that has no rules of that kind", async () => {
    // Not a 404: the host may well exist, and the order is what does not
    // describe it.
    seed([rewrite("00100")]);

    const res = await handler(event(REORDER, order("REDIRECT#00100")));

    expect(res.statusCode).toBe(409);
  });

  it("is forbidden to a viewer", async () => {
    const table = seed([redirect("00100"), redirect("00200")]);
    const before = await stored(table);

    const res = await handler(
      event(REORDER, order("REDIRECT#00200", "REDIRECT#00100"), VIEWER),
    );

    expect(res.statusCode).toBe(403);
    expect(await stored(table)).toEqual(before);
  });

  it("is not reachable as a rule id", async () => {
    // "reorder" is not a sort key, so the item routes cannot address it — and
    // the collection's own POST is create, which must not be shadowed either.
    seed([redirect("00100")]);

    const res = await handler({
      ...event(REORDER),
      requestContext: { http: { method: "GET" }, ...EDITOR },
    } as unknown as APIGatewayProxyEventV2);

    expect(res.statusCode).toBe(400);
    expect(parse(res.body)).toMatchObject({ error: { code: "BAD_REQUEST" } });
  });
});
