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

  /**
   * CF-43. Whether a pattern "mentions the query string" was decided by
   * `includes("?")`, but in a regex `?` is also a quantifier and part of group
   * syntax. So the patterns below were tested against path + query, and — being
   * anchored — silently stopped matching as soon as a request carried one.
   */
  describe("a ? that is regex syntax, not a query string", () => {
    const serviceFor = (matchValue: string, redirectURL = "/new") =>
      new RulesService(
        new FakeRepository([
          rule({
            redirectURL,
            matches: [
              { matchType: "path", matchOperator: "regex", matchValue },
            ],
          }),
        ]),
        60_000,
      );

    it.each([
      ["an optional trailing slash", "^/products/?$", "/products?utm=x"],
      ["an optional group", "^/(www-)?promo$", "/promo?utm=x"],
      ["a lazy quantifier", "^/old/[a-z]+?$", "/old/shoes?utm=x"],
      ["a non-capturing group", "^/(?:old|legacy)$", "/legacy?utm=x"],
      ["a lookahead", "^/(?=o)old$", "/old?utm=x"],
    ])(
      "still matches past the query string with %s",
      async (_, pattern, path) => {
        expect(
          await serviceFor(pattern).match(params({ path }), "REDIRECT"),
        ).toMatchObject({ redirectURL: "/new" });
      },
    );

    it.each([
      ["an escaped ?", "^/old\\?debug=1$"],
      ["a ? in a character class", "^/old[?]debug=1$"],
    ])("still sees the query string for %s", async (_, pattern) => {
      expect(
        await serviceFor(pattern).match(
          params({ path: "/old?debug=1" }),
          "REDIRECT",
        ),
      ).toMatchObject({ redirectURL: "/new" });
    });
  });

  it("still sees the query string for an equals value that contains a ?", async () => {
    // Outside regex mode a `?` is only ever literal, so it can only mean the
    // query string — this is the case the old check was right about.
    const service = new RulesService(
      new FakeRepository([
        rule({
          redirectURL: "/new",
          matches: [
            {
              matchType: "path",
              matchOperator: "equals",
              matchValue: "/old?debug=1",
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

  /**
   * CF-43. A regex that names a scheme is tested against the full URL, and that
   * branch returned early with the query string attached — so it had neither
   * fix the path branch has. A capture swallowed the query and then
   * `appendQueryStringIfNeeded` added it again; an anchored pattern stopped
   * matching once a query was present.
   */
  describe("a full-URL regex", () => {
    const serviceFor = (matchValue: string, over: Partial<RedirectRule> = {}) =>
      new RulesService(
        new FakeRepository([
          rule({
            redirectURL: "/new",
            matches: [
              { matchType: "regex", matchOperator: "regex", matchValue },
            ],
            ...over,
          } as Partial<RedirectRule>),
        ]),
        60_000,
      );

    it("appends the query string once, not inside the capture as well", async () => {
      const service = serviceFor("^https://www\\.example\\.com/old/(.*)$", {
        redirectURL: "/new/$1",
        useIncomingQueryString: true,
      } as Partial<RedirectRule>);

      expect(
        await service.match(
          params({ path: "/old/shoes?color=red" }),
          "REDIRECT",
        ),
      ).toMatchObject({ redirectURL: "/new/shoes?color=red" });
    });

    it("does not carry the query into the target when the rule drops it", async () => {
      // Before, `(.*)` smuggled the query into `$1` whatever the flag said.
      const service = serviceFor("^https://www\\.example\\.com/old/(.*)$", {
        redirectURL: "/new/$1",
      });

      expect(
        await service.match(
          params({ path: "/old/shoes?color=red" }),
          "REDIRECT",
        ),
      ).toMatchObject({ redirectURL: "/new/shoes" });
    });

    it("still matches an anchored pattern when a query string is present", async () => {
      expect(
        await serviceFor("^https://www\\.example\\.com/old$").match(
          params({ path: "/old?utm=x" }),
          "REDIRECT",
        ),
      ).toMatchObject({ redirectURL: "/new" });
    });

    it("still sees the query string when the pattern mentions it", async () => {
      expect(
        await serviceFor("^https://www\\.example\\.com/old\\?debug=1$").match(
          params({ path: "/old?debug=1" }),
          "REDIRECT",
        ),
      ).toMatchObject({ redirectURL: "/new" });
    });
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
