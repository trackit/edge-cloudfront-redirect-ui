import { describe, expect, it } from "vitest";
import { detectFormat, parseExport } from "../src/domain/akamaiImport";
import type { RedirectRuleInput, RuleInput } from "../src/api";

/**
 * The import parser's pure half: what a source string is detected as, how each
 * row maps onto our redirect model, and which host it lands on. All of it is
 * reachable without a DOM — the modal that drives it is a Playwright concern.
 *
 * Priorities are deliberately NOT asserted here: they are assigned per host at
 * import time against that host's live rules, not by the parser.
 */

const HOST = "www.example.com";

/** Narrows a batch input to a redirect so the redirect-only fields are readable. */
const asRedirect = (input: RuleInput | undefined): RedirectRuleInput => {
  expect(input).toBeDefined();
  expect(input?.type).toBe("erMatchRule");
  return input as RedirectRuleInput;
};

describe("detectFormat", () => {
  it("reads the Edge Redirector CSV header", () => {
    expect(
      detectFormat({
        filename: "export.csv",
        text: "ruleName,matchURL,redirectURL,result.statusCode\n",
      }),
    ).toBe("edge-redirector-csv");
  });

  it("reads a simple source/target CSV header", () => {
    expect(
      detectFormat({ filename: "map.csv", text: "source,target,status\n" }),
    ).toBe("simple-csv");
  });

  it.each([
    ["a bare array", "[]"],
    ["a rules wrapper", '{"rules":[]}'],
    ["a matchRules wrapper", '{"matchRules":[]}'],
  ])("reads matchRules JSON from %s", (_case, text) => {
    expect(detectFormat({ filename: "rules.json", text })).toBe(
      "match-rules-json",
    );
  });

  it("sniffs a JSON paste with no filename", () => {
    expect(detectFormat({ text: '{"rules":[]}' })).toBe("match-rules-json");
    expect(detectFormat({ text: "[]" })).toBe("match-rules-json");
  });

  it("does not silently fall back to CSV for an unknown header", () => {
    expect(detectFormat({ filename: "data.csv", text: "foo,bar\n1,2" })).toBe(
      "unrecognized",
    );
  });

  it("rejects gibberish and JSON of the wrong shape", () => {
    expect(detectFormat({ filename: "notes.txt", text: "hello world" })).toBe(
      "unrecognized",
    );
    expect(detectFormat({ filename: "x.json", text: '{"foo":1}' })).toBe(
      "unrecognized",
    );
  });
});

describe("parseExport — Edge Redirector CSV", () => {
  const csv = [
    "ruleName,matchURL,redirectURL,result.statusCode",
    "Rule A,/old-a,/new-a,301",
    "Rule B,/old-b,https://example.com/new-b,302",
  ].join("\n");

  it("maps clean rows to importable redirects on the target host", () => {
    const preview = parseExport(csv, { filename: "export.csv", defaultHost: HOST });

    expect(preview.format).toBe("edge-redirector-csv");
    expect(preview.rows).toHaveLength(2);
    expect(preview.summary).toEqual({
      ready: 2,
      warnings: 0,
      skipped: 0,
      hosts: 1,
    });

    const a = asRedirect(preview.rows[0].input);
    expect(preview.rows[0].host).toBe(HOST);
    expect(a.statusCode).toBe(301);
    expect(a.redirectURL).toBe("/new-a");
    expect(a.matches[0]).toMatchObject({
      matchType: "path",
      matchOperator: "equals",
      matchValue: "/old-a",
    });

    expect(asRedirect(preview.rows[1].input).statusCode).toBe(302);
  });

  it("translates a wildcard match to an anchored regex, with a warning", () => {
    const preview = parseExport(
      "ruleName,matchURL,redirectURL,result.statusCode\nW,/promo/*,/sale,301",
      { filename: "e.csv", defaultHost: HOST },
    );
    const row = preview.rows[0];
    expect(row.status).toBe("warning");
    expect(row.messages.join(" ")).toMatch(/wildcard/i);
    const match = asRedirect(row.input).matches[0];
    expect(match.matchOperator).toBe("regex");
    expect(() => new RegExp(match.matchValue)).not.toThrow();
    expect(new RegExp(match.matchValue).test("/promo/shoes")).toBe(true);
  });

  it("reduces an absolute match URL to its path, with a warning", () => {
    const preview = parseExport(
      "ruleName,matchURL,redirectURL,result.statusCode\nA,http://www.example.com/old,/new,301",
      { filename: "e.csv", defaultHost: HOST },
    );
    const row = preview.rows[0];
    expect(row.status).toBe("warning");
    expect(row.messages.join(" ")).toMatch(/absolute/i);
    expect(asRedirect(row.input).matches[0]).toMatchObject({
      matchType: "path",
      matchValue: "/old",
    });
  });

  it("skips a row with no redirect target and keeps its neighbours", () => {
    const withGap = [
      "ruleName,matchURL,redirectURL,result.statusCode",
      "Good 1,/a,/x,301",
      "Broken,/b,,301",
      "Good 2,/c,/y,301",
    ].join("\n");
    const preview = parseExport(withGap, { filename: "e.csv", defaultHost: HOST });

    expect(preview.rows.map((r) => r.status)).toEqual(["ok", "skipped", "ok"]);
    expect(preview.rows[1].input).toBeUndefined();
    expect(preview.rows[1].validation.length).toBeGreaterThan(0);
    expect(preview.summary).toMatchObject({ ready: 2, skipped: 1 });
  });

  it("maps an unsupported status code to 301, with a warning", () => {
    const preview = parseExport(
      "ruleName,matchURL,redirectURL,result.statusCode\nR,/a,/b,307",
      { filename: "e.csv", defaultHost: HOST },
    );
    const row = preview.rows[0];
    expect(row.status).toBe("warning");
    expect(row.messages.join(" ")).toMatch(/307/);
    expect(asRedirect(row.input).statusCode).toBe(301);
  });
});

describe("parseExport — simple CSV", () => {
  it("reads source/target with an explicit status column", () => {
    const preview = parseExport("source,target,status\n/a,/b,302", {
      filename: "map.csv",
      defaultHost: HOST,
    });
    const row = asRedirect(preview.rows[0].input);
    expect(row.statusCode).toBe(302);
    expect(row.redirectURL).toBe("/b");
    expect(row.matches[0].matchValue).toBe("/a");
  });

  it("defaults the status to 301 when the column is absent", () => {
    const preview = parseExport("source,target\n/a,/b", {
      filename: "map.csv",
      defaultHost: HOST,
    });
    expect(asRedirect(preview.rows[0].input).statusCode).toBe(301);
  });
});

describe("parseExport — matchRules JSON", () => {
  it("maps a clean matches[] rule and carries negate through", () => {
    const json = JSON.stringify({
      rules: [
        {
          name: "r1",
          redirectURL: "/dest",
          statusCode: 302,
          matches: [
            {
              matchType: "path",
              matchOperator: "equals",
              matchValue: "/src",
              negate: true,
            },
          ],
        },
      ],
    });
    const preview = parseExport(json, { filename: "rules.json", defaultHost: HOST });
    expect(preview.rows[0].status).toBe("ok");
    expect(preview.rows[0].host).toBe(HOST);
    const input = asRedirect(preview.rows[0].input);
    expect(input.statusCode).toBe(302);
    expect(input.matches[0]).toMatchObject({
      matchType: "path",
      matchValue: "/src",
      negate: true,
    });
  });

  it("carries a header condition's name into headerName", () => {
    const json = JSON.stringify([
      {
        name: "h",
        redirectURL: "/x",
        statusCode: 301,
        matches: [{ matchType: "header", name: "X-Country", matchValue: "FR" }],
      },
    ]);
    const preview = parseExport(json, { filename: "rules.json", defaultHost: HOST });
    expect(preview.rows[0].status).toBe("ok");
    expect(asRedirect(preview.rows[0].input).matches[0]).toMatchObject({
      matchType: "header",
      headerName: "X-Country",
    });
  });

  it("drops an unsupported condition to a warning, matching any request", () => {
    const json = JSON.stringify([
      {
        name: "api",
        redirectURL: "/api/v2",
        statusCode: 301,
        matches: [{ matchType: "method", matchValue: "GET" }],
      },
    ]);
    const preview = parseExport(json, { filename: "rules.json", defaultHost: HOST });
    const row = preview.rows[0];
    expect(row.status).toBe("warning");
    expect(row.messages.join(" ")).toMatch(/match type "method" not supported/);
    // The only condition was unmappable, so nothing is left to match on — the
    // rule is still importable and applies to every request.
    expect(asRedirect(row.input).matches).toHaveLength(0);
  });
});

describe("parseExport — host routing", () => {
  it("routes a rule to the host named by its hostname condition", () => {
    const json = JSON.stringify([
      {
        name: "Legacy home",
        redirectURL: "https://help.example.com",
        statusCode: 301,
        matches: [
          { matchType: "hostname", matchOperator: "equals", matchValue: "support.example.com" },
        ],
      },
    ]);
    const preview = parseExport(json, {
      filename: "rules.json",
      defaultHost: "shop.example.com",
    });
    const row = preview.rows[0];
    expect(row.status).toBe("ok");
    // The hostname condition became the partition and dropped out of matches.
    expect(row.host).toBe("support.example.com");
    expect(row.draft.matches).toHaveLength(0);
    expect(asRedirect(row.input).matches).toHaveLength(0);
  });

  it("counts the distinct hosts a file spans", () => {
    const json = JSON.stringify([
      { name: "a", matchURL: "/old-home", redirectURL: "/x", statusCode: 301 },
      { name: "b", matchURL: "/promo", redirectURL: "/y", statusCode: 302 },
      {
        name: "c",
        redirectURL: "https://help.example.com",
        statusCode: 301,
        matches: [{ matchType: "hostname", matchValue: "support.example.com" }],
      },
    ]);
    const preview = parseExport(json, {
      filename: "rules.json",
      defaultHost: "shop.example.com",
    });
    expect(preview.rows.map((r) => r.host)).toEqual([
      "shop.example.com",
      "shop.example.com",
      "support.example.com",
    ]);
    expect(preview.summary.hosts).toBe(2);
  });
});

describe("parseExport — unrecognized", () => {
  it("returns an error and no rows", () => {
    const preview = parseExport("total nonsense", {
      filename: "mystery.txt",
      defaultHost: HOST,
    });
    expect(preview.format).toBe("unrecognized");
    expect(preview.rows).toEqual([]);
    expect(preview.summary).toEqual({
      ready: 0,
      warnings: 0,
      skipped: 0,
      hosts: 0,
    });
    expect(preview.error).toBeDefined();
  });
});
