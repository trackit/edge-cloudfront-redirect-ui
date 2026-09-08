import { describe, expect, it, vi } from "vitest";
import { RulesService } from "../src/rules-service.js";
import type { RedirectRule, RequestParams } from "../src/rule-types.js";
import { FakeRepository } from "./fake-repository.js";

const HOST = "www.example.com";

const params = (over: Partial<RequestParams> = {}): RequestParams => ({
  hostname: HOST,
  path: "/old-landing",
  protocol: "https",
  headers: {},
  cookies: "",
  ...over,
});

const rule = (over: Partial<RedirectRule> = {}): RedirectRule =>
  ({
    pk: HOST,
    sk: "REDIRECT#00100",
    type: "erMatchRule",
    statusCode: 301,
    redirectURL: "https://www.example.com/new",
    matches: [
      {
        matchType: "path",
        matchOperator: "equals",
        matchValue: "/old-landing",
      },
    ],
    ...over,
  }) as RedirectRule;

describe("caching", () => {
  it("queries DynamoDB once for repeated requests within the TTL", async () => {
    const repo = new FakeRepository([rule()]);
    const service = new RulesService(repo, 60_000);

    await service.match(params(), "REDIRECT");
    await service.match(params(), "REDIRECT");
    await service.match(params({ path: "/other" }), "REDIRECT");

    expect(repo.queryCount).toBe(1);
  });

  it("re-queries once the TTL has elapsed", async () => {
    vi.useFakeTimers();
    try {
      const repo = new FakeRepository([rule()]);
      const service = new RulesService(repo, 60_000);

      await service.match(params(), "REDIRECT");
      vi.advanceTimersByTime(59_000);
      await service.match(params(), "REDIRECT");
      expect(repo.queryCount).toBe(1);

      vi.advanceTimersByTime(2_000);
      await service.match(params(), "REDIRECT");
      expect(repo.queryCount).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caches redirect and rewrite rules under separate keys", async () => {
    const repo = new FakeRepository([rule()]);
    const service = new RulesService(repo, 60_000);

    await service.match(params(), "REDIRECT");
    await service.match(params(), "REWRITE");

    expect(repo.queryCount).toBe(2);
  });

  it("caches per host", async () => {
    const repo = new FakeRepository([rule()]);
    const service = new RulesService(repo, 60_000);

    await service.match(params(), "REDIRECT");
    await service.match(params({ hostname: "other.example.com" }), "REDIRECT");

    expect(repo.queryCount).toBe(2);
  });

  it("queries every time when the TTL is zero", async () => {
    const repo = new FakeRepository([rule()]);
    const service = new RulesService(repo, 0);

    await service.match(params(), "REDIRECT");
    await service.match(params(), "REDIRECT");

    expect(repo.queryCount).toBe(2);
  });
});

describe("host lookup", () => {
  it("looks rules up under the lowercased host", async () => {
    // The console API stores every host lowercased, because a DynamoDB
    // partition key is case-sensitive and DNS is not. A viewer may still send
    // any case in the Host header; looking that up verbatim finds an empty
    // partition and every rule for the site silently stops firing.
    const repo = new FakeRepository([rule()]);
    const service = new RulesService(repo, 60_000);

    const result = await service.match(
      params({ hostname: "WWW.Example.COM" }),
      "REDIRECT",
    );

    expect(result).not.toBeNull();
  });

  it("shares one cache entry across spellings of a host", async () => {
    const repo = new FakeRepository([rule()]);
    const service = new RulesService(repo, 60_000);

    await service.match(params({ hostname: "WWW.Example.COM" }), "REDIRECT");
    await service.match(params({ hostname: "www.example.com" }), "REDIRECT");

    // Same rules either way, so caching them twice would be pure waste.
    expect(repo.queryCount).toBe(1);
  });

  it("still matches a hostname condition against what the viewer sent", async () => {
    // Only the *key* is lowered. A `hostname` match may be declared
    // caseSensitive, so the value it tests has to be the real header.
    const service = new RulesService(
      new FakeRepository([
        rule({
          matches: [
            {
              matchType: "hostname",
              matchOperator: "equals",
              matchValue: "WWW.Example.COM",
              caseSensitive: true,
            },
          ],
        }),
      ]),
      60_000,
    );

    expect(
      await service.match(params({ hostname: "WWW.Example.COM" }), "REDIRECT"),
    ).not.toBeNull();
    expect(
      await service.match(params({ hostname: "www.example.com" }), "REDIRECT"),
    ).toBeNull();
  });
});

describe("match conditions", () => {
  /**
   * The A/B-test shape, and the reason `cookieName` exists: the rule has to fire
   * for the visitor carrying `ab_test=on` and for nobody else. Compared against
   * the whole `Cookie` header, the second case below would have matched too,
   * because `london` contains `on`.
   */
  describe("a cookie condition", () => {
    const cookieRule = rule({
      matches: [
        {
          matchType: "cookie",
          cookieName: "ab_test",
          matchOperator: "equals",
          matchValue: "on",
        },
      ],
    });

    it.each([
      { what: "the named cookie holds the value", cookies: "x=1; ab_test=on" },
      { what: "it sits between others", cookies: "a=1; ab_test=on; b=2" },
    ])("fires when $what", async ({ cookies }) => {
      const service = new RulesService(
        new FakeRepository([cookieRule]),
        60_000,
      );
      expect(
        await service.match(params({ cookies }), "REDIRECT"),
      ).not.toBeNull();
    });

    it.each([
      {
        what: "another cookie merely contains the value",
        cookies: "region=london",
      },
      { what: "the named cookie holds something else", cookies: "ab_test=off" },
      { what: "the cookie is absent", cookies: "session=a1b2c3" },
      { what: "no cookies are sent", cookies: "" },
    ])("stays quiet when $what", async ({ cookies }) => {
      const service = new RulesService(
        new FakeRepository([cookieRule]),
        60_000,
      );
      expect(await service.match(params({ cookies }), "REDIRECT")).toBeNull();
    });

    it("does not fall back to the whole header when the name is missing", async () => {
      // An item written before the name was required. Matching on the whole
      // header again would resurrect exactly the bug this field removes.
      const nameless = rule({
        matches: [
          { matchType: "cookie", matchOperator: "contains", matchValue: "on" },
        ],
      });
      const service = new RulesService(new FakeRepository([nameless]), 60_000);
      expect(
        await service.match(params({ cookies: "region=london" }), "REDIRECT"),
      ).toBeNull();
    });
  });

  it("requires every condition to match", async () => {
    const service = new RulesService(
      new FakeRepository([
        rule({
          matches: [
            {
              matchType: "path",
              matchOperator: "equals",
              matchValue: "/old-landing",
            },
            {
              matchType: "hostname",
              matchOperator: "equals",
              matchValue: "other.example.com",
            },
          ],
        }),
      ]),
      60_000,
    );

    expect(await service.match(params(), "REDIRECT")).toBeNull();
  });

  it("honors negate", async () => {
    const service = new RulesService(
      new FakeRepository([
        rule({
          matches: [
            {
              matchType: "path",
              matchOperator: "equals",
              matchValue: "/old-landing",
              negate: true,
            },
          ],
        }),
      ]),
      60_000,
    );

    expect(await service.match(params(), "REDIRECT")).toBeNull();
    expect(
      await service.match(params({ path: "/elsewhere" }), "REDIRECT"),
    ).not.toBeNull();
  });

  it("is case-insensitive by default and exact when caseSensitive is set", async () => {
    const insensitive = new RulesService(new FakeRepository([rule()]), 60_000);
    expect(
      await insensitive.match(params({ path: "/OLD-LANDING" }), "REDIRECT"),
    ).not.toBeNull();

    const sensitive = new RulesService(
      new FakeRepository([
        rule({
          matches: [
            {
              matchType: "path",
              matchOperator: "equals",
              matchValue: "/old-landing",
              caseSensitive: true,
            },
          ],
        }),
      ]),
      60_000,
    );
    expect(
      await sensitive.match(params({ path: "/OLD-LANDING" }), "REDIRECT"),
    ).toBeNull();
  });

  it("expands regex capture groups into the target", async () => {
    const service = new RulesService(
      new FakeRepository([
        rule({
          redirectURL: "https://www.example.com/products/$1",
          matches: [
            {
              matchType: "regex",
              matchOperator: "regex",
              matchValue: "^/items/(\\d+)$",
            },
          ],
        }),
      ]),
      60_000,
    );

    const result = await service.match(
      params({ path: "/items/42" }),
      "REDIRECT",
    );

    expect(result).toEqual({
      type: "redirect",
      statusCode: 301,
      redirectURL: "https://www.example.com/products/42",
    });
  });

  /**
   * A regex condition is written against a path, so it is tested against the path
   * — the query string is not part of the subject unless the pattern says it is.
   * Anchored patterns are the common case in a migrated redirect map, and testing
   * one against `path?utm=x` would silently stop matching campaign traffic.
   */
  it("tests a regex against the path, not the query string", async () => {
    const service = new RulesService(
      new FakeRepository([
        rule({
          redirectURL: "/new/$1",
          matches: [
            {
              matchType: "regex",
              matchOperator: "regex",
              matchValue: "^/old/([a-z]+)$",
            },
          ],
        }),
      ]),
      60_000,
    );

    expect(
      await service.match(params({ path: "/old/shoes?utm=x" }), "REDIRECT"),
    ).toMatchObject({ redirectURL: "/new/shoes" });
  });

  /**
   * The capture feeds `$1`, so a `(.*)` that swallowed the query string would put
   * it in the target — and `appendQueryStringIfNeeded` would then add it a second
   * time, handing the viewer a URL with the same parameter twice.
   */
  it("keeps the query string out of a capture, so it is not duplicated", async () => {
    const service = new RulesService(
      new FakeRepository([
        rule({
          redirectURL: "/new/$1",
          useIncomingQueryString: true,
          matches: [
            {
              matchType: "path",
              matchOperator: "regex",
              matchValue: "^/old/(.*)$",
            },
          ],
        } as Partial<RedirectRule>),
      ]),
      60_000,
    );

    expect(
      await service.match(params({ path: "/old/shoes?color=red" }), "REDIRECT"),
    ).toMatchObject({ redirectURL: "/new/shoes?color=red" });
  });

  it("still sees the query string when the pattern mentions it", async () => {
    const service = new RulesService(
      new FakeRepository([
        rule({
          redirectURL: "/new",
          matches: [
            {
              matchType: "regex",
              matchOperator: "regex",
              matchValue: "^/old\\?debug=1$",
            },
          ],
        }),
      ]),
      60_000,
    );

    expect(
      await service.match(params({ path: "/old?debug=1" }), "REDIRECT"),
    ).toMatchObject({ redirectURL: "/new" });
  });

  it("skips a rule with a malformed regex instead of failing the whole match", async () => {
    const service = new RulesService(
      new FakeRepository([
        rule({
          sk: "REDIRECT#00001",
          redirectURL: "https://www.example.com/bad",
          matches: [
            // Unbalanced group — RegExp construction throws.
            {
              matchType: "regex",
              matchOperator: "regex",
              matchValue: "^/items/(",
            },
          ],
        }),
        rule({
          sk: "REDIRECT#00002",
          redirectURL: "https://www.example.com/good",
          matches: [
            {
              matchType: "path",
              matchOperator: "equals",
              matchValue: "/old-landing",
            },
          ],
        }),
      ]),
      60_000,
    );

    const result = await service.match(params(), "REDIRECT");

    // The bad rule is skipped; the next valid rule still applies.
    expect(result).toMatchObject({
      type: "redirect",
      redirectURL: "https://www.example.com/good",
    });
  });

  it("matches a header by name", async () => {
    const service = new RulesService(
      new FakeRepository([
        rule({
          matches: [
            {
              matchType: "header",
              matchOperator: "contains",
              matchValue: "mobile",
              headerName: "User-Agent",
            },
          ],
        }),
      ]),
      60_000,
    );

    expect(
      await service.match(
        params({ headers: { "user-agent": "Mozilla Mobile Safari" } }),
        "REDIRECT",
      ),
    ).not.toBeNull();
    expect(
      await service.match(
        params({ headers: { "user-agent": "Mozilla Desktop" } }),
        "REDIRECT",
      ),
    ).toBeNull();
  });
});
