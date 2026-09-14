import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EDITOR } from "./principal-claims.js";
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
    requestContext: { http: { method }, ...EDITOR },
  }) as unknown as APIGatewayProxyEventV2;

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

  it("405s a method the collection does not serve", async () => {
    const res = await handler(event("PUT", "/targets/t1/hosts"));
    expect(res.statusCode).toBe(405);
  });
});

describe("POST /targets/:targetId/hosts", () => {
  const create = (host: unknown) =>
    handler(event("POST", "/targets/t1/hosts", { host }));

  it("creates a host with no rules and returns it with zero counts", async () => {
    const res = await create("shop.example.com");

    expect(res.statusCode).toBe(201);
    expect(parse(res.body)).toEqual({
      host: "shop.example.com",
      redirects: 0,
      rewrites: 0,
    });
  });

  it("makes the host survive a reload", async () => {
    // The whole point: without the marker item, listHosts derives hosts from
    // rules and an empty one cannot come back at all.
    await create("shop.example.com");

    expect(
      parse((await handler(event("GET", "/targets/t1/hosts"))).body),
    ).toEqual([{ host: "shop.example.com", redirects: 0, rewrites: 0 }]);
  });

  it("can then be deleted like any other host", async () => {
    // The marker sits in the partition, so deleteHost takes it with everything
    // else — an empty host must not become undeletable.
    await create("shop.example.com");

    const res = await handler(
      event("DELETE", "/targets/t1/hosts/shop.example.com"),
    );
    expect(res.statusCode).toBe(204);
    expect(
      parse((await handler(event("GET", "/targets/t1/hosts"))).body),
    ).toEqual([]);
  });

  it("does not disturb a host's rule counts", async () => {
    seed(rule("www.example.com", "REDIRECT#00100"));
    await create("shop.example.com");

    expect(
      parse((await handler(event("GET", "/targets/t1/hosts"))).body),
    ).toEqual([
      { host: "shop.example.com", redirects: 0, rewrites: 0 },
      { host: "www.example.com", redirects: 1, rewrites: 0 },
    ]);
  });

  it("409s a host that already has rules", async () => {
    // Existing means anything under the partition, not just a previous marker —
    // otherwise adding a live host would write a marker beside its rules.
    seed(rule("www.example.com", "REDIRECT#00100"));

    const res = await create("www.example.com");
    expect(res.statusCode).toBe(409);
    expect(parse(res.body)).toMatchObject({ error: { code: "HOST_EXISTS" } });
  });

  it("409s the same empty host twice", async () => {
    await create("shop.example.com");

    expect((await create("shop.example.com")).statusCode).toBe(409);
  });

  it("stores the host lowercased", async () => {
    // A partition key is case-sensitive and DNS is not, so two cases would be
    // two sidebar entries, only one of which the edge can ever match.
    const res = await create("Shop.Example.COM");

    expect(parse(res.body)).toMatchObject({ host: "shop.example.com" });
    expect((await create("shop.example.com")).statusCode).toBe(409);
  });

  it.each([
    ["a URL rather than a hostname", "https://shop.example.com"],
    ["a path", "shop.example.com/sale"],
    ["a port", "shop.example.com:443"],
    ["a trailing dot", "shop.example.com."],
    ["a space", "shop example.com"],
    ["empty", ""],
    ["a leading hyphen in a label", "-shop.example.com"],
  ])("400s %s", async (_label, host) => {
    // The modal's own hint says "not the redirect destination", and users paste
    // a URL in anyway. Stored, it becomes a partition key no request can match.
    const res = await create(host);

    expect(res.statusCode).toBe(400);
    expect(parse(res.body)).toMatchObject({
      error: { code: "VALIDATION_ERROR", details: [{ path: "/host" }] },
    });
  });

  it("400s a body that is not a host at all", async () => {
    expect(
      (await handler(event("POST", "/targets/t1/hosts", { nope: 1 })))
        .statusCode,
    ).toBe(400);
    expect((await create(42)).statusCode).toBe(400);
  });

  it("is the same host a rule route addresses in another case", async () => {
    // The bug this closes: createRule took the host from the path untouched, so
    // a rule created at `WWW.Example.com` landed in a partition the console —
    // which lists lowercased hosts — could never show or delete.
    await create("shop.example.com");

    const created = await handler(
      event("POST", "/targets/t1/hosts/SHOP.Example.COM/rules", {
        type: "erMatchRule",
        priority: 100,
        statusCode: 301,
        redirectURL: "https://example.com/new",
        matches: [
          { matchType: "path", matchOperator: "equals", matchValue: "/old" },
        ],
      }),
    );
    expect(created.statusCode).toBe(201);
    expect(parse(created.body)).toMatchObject({ pk: "shop.example.com" });

    // One host, one partition, and the rule is visible from the lowercase path.
    expect(
      parse((await handler(event("GET", "/targets/t1/hosts"))).body),
    ).toEqual([{ host: "shop.example.com", redirects: 1, rewrites: 0 }]);

    const listed = await handler(
      event("GET", "/targets/t1/hosts/shop.example.com/rules"),
    );
    expect((parse(listed.body) as unknown[]).length).toBe(1);
  });

  it("does not show its marker in the host's rule list", async () => {
    // The marker shares the partition with the rules, so a listing that took
    // the whole partition would put a phantom row in the console — an entry with
    // no type, priority or action, on every host added this way.
    await create("shop.example.com");

    const res = await handler(
      event("GET", "/targets/t1/hosts/shop.example.com/rules"),
    );
    expect(res.statusCode).toBe(200);
    expect(parse(res.body)).toEqual([]);
  });

  it("404s an unknown target before validating the body", async () => {
    // A caller cannot tell a bad target from a bad host otherwise.
    const res = await handler(
      event("POST", "/targets/nope/hosts", { host: "not a host" }),
    );

    expect(res.statusCode).toBe(404);
    expect(parse(res.body)).toMatchObject({
      error: { code: "UNKNOWN_TARGET" },
    });
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

  it("404s a host nothing is stored under", async () => {
    /*
      Nothing in the partition — not a rule, not a marker — so there is no host to
      remove and reporting success would hide a typo or a second click on the
      trash icon. Deliberately *not* "a host with no rules": one of those has a
      marker, exists, and deletes with a 204, which the POST block above covers.

      The message is asserted, not just the code. It is the whole point of the
      wording: saying "no rules for host" would describe the case this is not, and
      tell someone their host exists and is empty when it is not there at all.
    */
    seed(rule("www.example.com", "REDIRECT#00100"));

    const res = await handler(
      event("DELETE", "/targets/t1/hosts/other.example.com"),
    );
    expect(res.statusCode).toBe(404);
    expect(parse(res.body)).toMatchObject({
      error: {
        code: "NOT_FOUND",
        message: 'No such host "other.example.com" in this target',
      },
    });
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

describe("a host outlives its rules however it came to exist", () => {
  /*
    A host is only ever a rule's partition key, so without a marker it exists
    exactly as long as it has rules. `createHost` writes one — which used to mean
    the sidebar kept a host added through the console and dropped one that first
    appeared because somebody wrote a rule for it, two hosts in the same state
    behaving differently for a reason nobody can see from the console.

    Creating a rule now leaves the marker too, so these two arrive at the same
    place.
  */
  const listed = async () =>
    parse((await handler(event("GET", "/targets/t1/hosts"))).body);

  /** A complete rule body — this suite is about the host, not about validation. */
  const ruleInput = {
    priority: 100,
    type: "erMatchRule",
    statusCode: 301,
    redirectURL: "https://www.example.com/moved",
    matches: [
      { matchType: "path", matchOperator: "equals", matchValue: "/old" },
    ],
  };

  it("keeps a host reached by writing a rule, once that rule is deleted", async () => {
    seed();

    const created = await handler(
      event("POST", "/targets/t1/hosts/www.example.com/rules", ruleInput),
    );
    expect(created.statusCode).toBe(201);

    const gone = await handler(
      event(
        "DELETE",
        "/targets/t1/hosts/www.example.com/rules/REDIRECT%2300100",
      ),
    );
    expect(gone.statusCode).toBe(204);

    expect(await listed()).toEqual([
      { host: "www.example.com", redirects: 0, rewrites: 0 },
    ]);
  });

  it("matches what an explicitly added host does", async () => {
    seed();
    await handler(
      event("POST", "/targets/t1/hosts", { host: "www.example.com" }),
    );

    expect(await listed()).toEqual([
      { host: "www.example.com", redirects: 0, rewrites: 0 },
    ]);
  });

  it("repairs a host whose rules predate the marker, by adding it again", async () => {
    /*
      Rules already in a real table were written before a create left a marker,
      so their hosts still vanish with the last of them. Adding the host is the
      documented way back, and it has to actually work: the host reads as
      existing, so the 409 stands — but the marker is written on the way out,
      and that is what the caller is really after.
    */
    seed(rule("www.example.com", "REDIRECT#00100"));

    const res = await handler(
      event("POST", "/targets/t1/hosts", { host: "www.example.com" }),
    );
    expect(res.statusCode).toBe(409);

    const gone = await handler(
      event(
        "DELETE",
        "/targets/t1/hosts/www.example.com/rules/REDIRECT%2300100",
      ),
    );
    expect(gone.statusCode).toBe(204);

    expect(await listed()).toEqual([
      { host: "www.example.com", redirects: 0, rewrites: 0 },
    ]);
  });

  it("still takes the host away when the host itself is deleted", async () => {
    // The marker must not turn a deleted host into one that cannot be removed.
    seed();
    await handler(
      event("POST", "/targets/t1/hosts/www.example.com/rules", ruleInput),
    );

    const res = await handler(
      event("DELETE", "/targets/t1/hosts/www.example.com"),
    );
    expect(res.statusCode).toBe(204);
    expect(await listed()).toEqual([]);
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
