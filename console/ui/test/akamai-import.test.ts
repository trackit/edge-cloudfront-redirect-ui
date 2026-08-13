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

  it("reads a flattened Edge Redirector policy CSV header", () => {
    expect(
      detectFormat({
        filename: "policy.csv",
        text: "policyId,policyName,statusCode,redirectURL,matchType,matchOperator,matchValue\n",
      }),
    ).toBe("edge-redirector-policy-csv");
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

  it("keeps a wildcard match verbatim for the edge to expand", () => {
    const preview = parseExport(
      "ruleName,matchURL,redirectURL,result.statusCode\nW,/promo/*,/sale,301",
      { filename: "e.csv", defaultHost: HOST },
    );
    const row = preview.rows[0];
    // The target has no capture, so the wildcard is passed through untouched —
    // the edge expands `*` itself. No translation means no warning.
    expect(row.status).toBe("ok");
    expect(asRedirect(row.input).matches[0]).toMatchObject({
      matchType: "path",
      matchOperator: "equals",
      matchValue: "/promo/*",
    });
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

  it("passes a regex matchType through verbatim, without glob mangling", () => {
    const json = JSON.stringify([
      {
        name: "rx",
        redirectURL: "/$1",
        statusCode: 301,
        matches: [{ matchType: "regex", matchValue: "^/products/(.*)$" }],
      },
    ]);
    const preview = parseExport(json, { filename: "rules.json", defaultHost: HOST });
    const row = preview.rows[0];
    // Supported, so no "not supported" message; verbatim, so no "wildcard" one.
    expect(row.messages.join(" ")).not.toMatch(/not supported|wildcard/);
    const match = asRedirect(row.input).matches[0];
    expect(match).toMatchObject({
      matchType: "regex",
      matchOperator: "regex",
      matchValue: "^/products/(.*)$",
    });
  });

  it("unwraps a policy-metadata envelope and maps the wrapped rule", () => {
    // The real validation-set shape: each rule sits under a `rule` key next to
    // `policyId` / `policyName` / `why`. Without unwrapping, every row reads as
    // "Missing redirectURL". The rule is the classic "add trailing slash".
    const json = JSON.stringify({
      ruleCount: 1,
      rules: [
        {
          policyId: 5001,
          policyName: "Redirects_demo_BE",
          why: ["negate", "op=contains", "regex"],
          rule: {
            type: "erMatchRule",
            name: "Add Trailing /",
            matchURL: null,
            matches: [
              {
                matchType: "path",
                matchOperator: "contains",
                matchValue: "/*/",
                negate: true,
                caseSensitive: false,
              },
              {
                matchType: "regex",
                matchOperator: "equals",
                matchValue: "(.*)\\/([^\\?\\/]+)[\\?]*.*",
                negate: false,
                caseSensitive: false,
              },
            ],
            statusCode: 301,
            redirectURL: "\\1/\\2/",
            useIncomingQueryString: true,
          },
        },
      ],
    });
    const preview = parseExport(json, { filename: "set.json", defaultHost: HOST });
    expect(preview.rows).toHaveLength(1);
    const row = preview.rows[0];
    expect(row.status).not.toBe("skipped");
    const input = asRedirect(row.input);
    expect(input.redirectURL).toBe("$1/$2/");
    expect(input.useIncomingQueryString).toBe(true);
    // The negated glob stays a verbatim guard; the explicit regex keeps the
    // capture (it must not be stolen by converting the glob to a regex).
    expect(input.matches[0]).toMatchObject({
      matchType: "path",
      matchOperator: "contains",
      matchValue: "/*/",
      negate: true,
    });
    expect(input.matches[1]).toMatchObject({
      matchType: "regex",
      matchOperator: "regex",
      matchValue: "(.*)\\/([^\\?\\/]+)[\\?]*.*",
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

describe("parseExport — Edge Redirector policy CSV", () => {
  const HEADER =
    "policyId,policyName,why,statusCode,redirectURL,useIncomingQueryString," +
    "useRelativeUrl,matchType,matchOperator,matchValue,negate,caseSensitive";

  it("maps a wildcard-capture redirect, translating \\1 to $1", () => {
    // The real Akamai shape: a wildcard match feeding a backreference target.
    const csv = `${HEADER}\n5001,P_BE,note,301,\\1/\\2/,True,,path,contains,/*/*/,False,False`;
    const preview = parseExport(csv, { filename: "policy.csv", defaultHost: HOST });

    expect(preview.format).toBe("edge-redirector-policy-csv");
    expect(preview.rows).toHaveLength(1);

    const row = preview.rows[0];
    // Importable even though the relative target does not start with "/", because
    // it reinjects a capture whose shape is only known at the edge.
    expect(row.status).not.toBe("skipped");
    const input = asRedirect(row.input);
    expect(input.redirectURL).toBe("$1/$2/");
    expect(input.statusCode).toBe(301);
    expect(input.useIncomingQueryString).toBe(true);

    const match = input.matches[0];
    expect(match.matchOperator).toBe("regex");
    // Capturing groups, so $1 / $2 have something to resolve to.
    expect(new RegExp(match.matchValue).exec("/a/b/")?.slice(1)).toEqual([
      "a",
      "b",
    ]);
  });

  it("groups rows sharing a policyId into one rule, ANDing their conditions", () => {
    const csv = [
      HEADER,
      "500,Multi,note,302,/dest,,,path,equals,/old,False,False",
      "500,Multi,note,302,/dest,,,hostname,equals,shop.example.com,False,False",
    ].join("\n");
    const preview = parseExport(csv, { filename: "policy.csv", defaultHost: HOST });

    expect(preview.rows).toHaveLength(1);
    const row = preview.rows[0];
    // The hostname condition routed the rule to its own host and dropped out.
    expect(row.host).toBe("shop.example.com");
    const input = asRedirect(row.input);
    expect(input.statusCode).toBe(302);
    expect(input.matches).toHaveLength(1);
    expect(input.matches[0]).toMatchObject({
      matchType: "path",
      matchValue: "/old",
    });
  });

  it("treats rows without a policyId as separate rules", () => {
    const csv = [
      HEADER,
      ",A,,301,/x,,,path,equals,/a,False,False",
      ",B,,301,/y,,,path,equals,/b,False,False",
    ].join("\n");
    const preview = parseExport(csv, { filename: "policy.csv", defaultHost: HOST });
    expect(preview.rows).toHaveLength(2);
    expect(preview.rows.map((r) => r.status)).toEqual(["ok", "ok"]);
  });

  it("warns when a target reinjects a capture no condition provides", () => {
    const csv = `${HEADER}\n7,Lost,note,301,\\1/gone,,,path,equals,/exact,False,False`;
    const preview = parseExport(csv, { filename: "policy.csv", defaultHost: HOST });
    const row = preview.rows[0];
    expect(row.status).toBe("warning");
    expect(row.messages.join(" ")).toMatch(/reinjects a captured group/);
    expect(asRedirect(row.input).redirectURL).toBe("$1/gone");
  });

  it("keeps space-separated alternatives verbatim for the edge to expand", () => {
    // Akamai's `/ /*` means "/ OR /*" (a catch-all): the edge splits on space
    // and expands each natively. Translating it to one regex would break both
    // the alternatives and the unanchored `contains` semantics.
    const csv =
      `${HEADER}\n42,Catchall,note,301,https://example.com/nl,False,,` +
      `path,contains,/ /*,False,False`;
    const preview = parseExport(csv, { filename: "policy.csv", defaultHost: HOST });
    const row = preview.rows[0];
    expect(row.status).toBe("ok");
    const input = asRedirect(row.input);
    expect(input.redirectURL).toBe("https://example.com/nl");
    expect(input.matches[0]).toMatchObject({
      matchType: "path",
      matchOperator: "contains",
      matchValue: "/ /*",
    });
  });

  it("carries negate and honours useIncomingQueryString=false", () => {
    const csv = `${HEADER}\n9,Neg,note,301,/here,False,,path,equals,/there,True,False`;
    const preview = parseExport(csv, { filename: "policy.csv", defaultHost: HOST });
    const input = asRedirect(preview.rows[0].input);
    expect(input.useIncomingQueryString).toBe(false);
    expect(input.matches[0].negate).toBe(true);
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

describe("parseExport — policy index", () => {
  it("recognises a policy index and explains it has no rules", () => {
    const json = JSON.stringify([
      { policyId: 1001, policyName: "A", ruleCount: 12, source: "akamai-property-export" },
      { policyId: 1002, policyName: "B", ruleCount: 8, source: "akamai-property-export" },
    ]);
    const preview = parseExport(json, { filename: "policies.json", defaultHost: HOST });
    expect(preview.rows).toEqual([]);
    expect(preview.error).toMatch(/policy index/i);
    expect(preview.error).toMatch(/2 policies/);
    expect(preview.error).toMatch(/matchRules/);
  });

  it("does not mistake real wrapped rules for an index", () => {
    const json = JSON.stringify({
      rules: [
        {
          policyId: 1,
          policyName: "A",
          rule: {
            type: "erMatchRule",
            redirectURL: "/x",
            statusCode: 301,
            matches: [{ matchType: "path", matchOperator: "equals", matchValue: "/a" }],
          },
        },
      ],
    });
    const preview = parseExport(json, { filename: "set.json", defaultHost: HOST });
    expect(preview.rows).toHaveLength(1);
    expect(preview.rows[0].status).not.toBe("skipped");
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
