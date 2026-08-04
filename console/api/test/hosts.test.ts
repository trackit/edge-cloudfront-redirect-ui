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
  summarizeHosts,
  type RuleItem,
} from "../src/lib/rules-repository.js";
import { FakeTargetsRepository } from "./fake-targets-repository.js";
import { FakeRulesRepository } from "./fake-rules-repository.js";

const target = {
  id: "t1",
  name: "Prod",
  region: "us-east-1",
  tableName: "rules-prod",
};

const event = (method: string, path: string): APIGatewayProxyEventV2 =>
  ({
    rawPath: path,
    headers: {},
    isBase64Encoded: false,
    requestContext: { http: { method } },
  }) as APIGatewayProxyEventV2;

const parse = (body: string | undefined): unknown =>
  JSON.parse(body ?? "null") as unknown;

const rule = (pk: string, sk: string): RuleItem => ({
  pk,
  sk,
  type: sk.startsWith("REDIRECT#") ? "erMatchRule" : "frMatchRule",
});

// One instance behind the factory, not one per call: the factory runs per
// request, so a fresh repository each time would silently undo every write
// between two requests in the same test.
const seed = (...items: RuleItem[]) => {
  const repository = new FakeRulesRepository(items);
  setRulesRepositoryFactory(() => repository);
};

beforeEach(() => {
  setTargetsRepository(new FakeTargetsRepository([target]));
  seed();
});

afterEach(() => {
  resetTargetsRepository();
  resetRulesRepositoryFactory();
});

describe("GET /targets/:targetId/hosts", () => {
  it("lists each host once, with per-kind counts", async () => {
    seed(
      rule("www.example.com", "REDIRECT#00100"),
      rule("www.example.com", "REDIRECT#00200"),
      rule("www.example.com", "REWRITE#00150"),
      rule("shop.example.com", "REDIRECT#00100"),
    );

    const res = await handler(event("GET", "/targets/t1/hosts"));
    expect(res.statusCode).toBe(200);
    expect(parse(res.body)).toEqual([
      { host: "shop.example.com", redirects: 1, rewrites: 0 },
      { host: "www.example.com", redirects: 2, rewrites: 1 },
    ]);
  });

  it("sorts by host name", async () => {
    // The fake deliberately does not return items in insertion order, so a
    // handler that forgot to sort would surface here rather than in the UI.
    seed(
      rule("www.example.com", "REDIRECT#00100"),
      rule("assets.example.com", "REDIRECT#00100"),
      rule("shop.example.com", "REDIRECT#00100"),
    );

    const res = await handler(event("GET", "/targets/t1/hosts"));
    const hosts = (parse(res.body) as { host: string }[]).map((h) => h.host);
    expect(hosts).toEqual([
      "assets.example.com",
      "shop.example.com",
      "www.example.com",
    ]);
  });

  it("is an empty array for a target with no rules, not a 404", async () => {
    const res = await handler(event("GET", "/targets/t1/hosts"));
    expect(res.statusCode).toBe(200);
    expect(parse(res.body)).toEqual([]);
  });

  it("404s an unknown target", async () => {
    const res = await handler(event("GET", "/targets/nope/hosts"));
    expect(res.statusCode).toBe(404);
    expect(parse(res.body)).toMatchObject({
      error: { code: "UNKNOWN_TARGET" },
    });
  });

  it("does not collide with the rules route under the same prefix", async () => {
    // `/targets/:targetId/hosts` and `/targets/:targetId/hosts/:host/rules`
    // share a prefix; a router matching on prefix rather than segment count
    // would answer one with the other.
    seed(rule("www.example.com", "REDIRECT#00100"));

    const hosts = await handler(event("GET", "/targets/t1/hosts"));
    const rules = await handler(
      event("GET", "/targets/t1/hosts/www.example.com/rules"),
    );

    expect(parse(hosts.body)).toEqual([
      { host: "www.example.com", redirects: 1, rewrites: 0 },
    ]);
    expect(parse(rules.body)).toEqual([
      { pk: "www.example.com", sk: "REDIRECT#00100", type: "erMatchRule" },
    ]);
  });

  it("405s a write to the collection", async () => {
    const res = await handler(event("POST", "/targets/t1/hosts"));
    expect(res.statusCode).toBe(405);
  });
});

describe("DELETE /targets/:targetId/hosts/:host", () => {
  it("removes the host's rules and answers 204", async () => {
    seed(
      rule("www.example.com", "REDIRECT#00100"),
      rule("www.example.com", "REWRITE#00150"),
    );

    const res = await handler(
      event("DELETE", "/targets/t1/hosts/www.example.com"),
    );
    expect(res.statusCode).toBe(204);

    const after = await handler(event("GET", "/targets/t1/hosts"));
    expect(parse(after.body)).toEqual([]);
  });

  it("leaves every other host alone", async () => {
    // The delete is scoped to one partition; a filter on the wrong field would
    // take the whole table with it.
    seed(
      rule("www.example.com", "REDIRECT#00100"),
      rule("shop.example.com", "REDIRECT#00100"),
      rule("shop.example.com", "REWRITE#00150"),
    );

    await handler(event("DELETE", "/targets/t1/hosts/www.example.com"));

    expect(
      parse((await handler(event("GET", "/targets/t1/hosts"))).body),
    ).toEqual([{ host: "shop.example.com", redirects: 1, rewrites: 1 }]);
  });

  it("404s a host with no rules", async () => {
    // Same stored state as a host that never existed, so it cannot report a
    // success — that would hide a typo or a second click on the trash icon.
    seed(rule("www.example.com", "REDIRECT#00100"));

    const res = await handler(
      event("DELETE", "/targets/t1/hosts/other.example.com"),
    );
    expect(res.statusCode).toBe(404);
    expect(parse(res.body)).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("404s the second delete of the same host", async () => {
    seed(rule("www.example.com", "REDIRECT#00100"));

    const first = await handler(
      event("DELETE", "/targets/t1/hosts/www.example.com"),
    );
    const second = await handler(
      event("DELETE", "/targets/t1/hosts/www.example.com"),
    );

    expect(first.statusCode).toBe(204);
    expect(second.statusCode).toBe(404);
  });

  it("404s an unknown target before touching any table", async () => {
    const res = await handler(
      event("DELETE", "/targets/nope/hosts/www.example.com"),
    );
    expect(res.statusCode).toBe(404);
    expect(parse(res.body)).toMatchObject({
      error: { code: "UNKNOWN_TARGET" },
    });
  });

  it("decodes a percent-encoded host", async () => {
    // The client encodes every path segment, so the host arrives encoded. Left
    // undecoded it addresses a partition key that does not exist, and the delete
    // reports 404 for a host sitting right there.
    seed(rule("www.example.com", "REDIRECT#00100"));

    const res = await handler(
      event("DELETE", "/targets/t1/hosts/www%2Eexample%2Ecom"),
    );
    expect(res.statusCode).toBe(204);
    expect(
      parse((await handler(event("GET", "/targets/t1/hosts"))).body),
    ).toEqual([]);
  });

  it("does not delete the rules collection route by mistake", async () => {
    // `/hosts/:host` and `/hosts/:host/rules` differ by one segment; a router
    // matching loosely would let a DELETE on the rules path wipe the host.
    seed(rule("www.example.com", "REDIRECT#00100"));

    const res = await handler(
      event("DELETE", "/targets/t1/hosts/www.example.com/rules"),
    );

    expect(res.statusCode).toBe(405);
    expect(
      parse((await handler(event("GET", "/targets/t1/hosts"))).body),
    ).toEqual([{ host: "www.example.com", redirects: 1, rewrites: 0 }]);
  });
});

describe("summarizeHosts", () => {
  it("counts disabled rules like any other", async () => {
    // The projection reads pk and sk only, so `disabled` is not even fetched —
    // the count is of rules that exist, not rules that are live. The sidebar
    // badge would otherwise disagree with the rule list below it.
    seed(
      { ...rule("www.example.com", "REDIRECT#00100"), disabled: true },
      rule("www.example.com", "REDIRECT#00200"),
    );

    const res = await handler(event("GET", "/targets/t1/hosts"));
    expect(parse(res.body)).toEqual([
      { host: "www.example.com", redirects: 2, rewrites: 0 },
    ]);
  });

  it("lists a host whose sk is neither kind, counting it as neither", () => {
    // Room for a future marker item standing for a host with no rules. It must
    // put the host on the list without inflating either count.
    expect(summarizeHosts([{ pk: "www.example.com", sk: "HOST" }])).toEqual([
      { host: "www.example.com", redirects: 0, rewrites: 0 },
    ]);
  });

  it("is empty for no keys", () => {
    expect(summarizeHosts([])).toEqual([]);
  });
});
