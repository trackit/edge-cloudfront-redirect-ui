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
