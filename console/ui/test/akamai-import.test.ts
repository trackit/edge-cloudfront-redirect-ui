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
    const preview = parseExport(csv, {
      filename: "export.csv",
      defaultHost: HOST,
    });

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

  /**
   * `?` is a literal in an Akamai match value, and the edge treats it as one
   * (`checkAkamaiVariant` escapes it). Reading it as a single-character wildcard
   * would both widen the match and hand `$1` the `?` character itself.
   */
  it("treats ? as a literal, so only * drives a capture", () => {
    const preview = parseExport(
      [
        "ruleName,matchURL,redirectURL,result.statusCode",
        "Q,/promo?id=5,/new/\\1,302",
        "S,/old/*,/new/\\1,301",
      ].join("\n"),
      { filename: "e.csv", defaultHost: HOST },
    );

    // No `*`, so nothing is rewritten: the value keeps its literal `?` and the
    // target's `$1` has no group to draw from, which is worth saying.
    expect(asRedirect(preview.rows[0].input).matches[0]).toMatchObject({
      matchOperator: "equals",
      matchValue: "/promo?id=5",
    });
    expect(preview.rows[0].messages.join(" ")).toMatch(/captures one/);

    expect(asRedirect(preview.rows[1].input).matches[0]).toMatchObject({
      matchOperator: "regex",
      matchValue: "^/old/(.*)$",
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
    const preview = parseExport(withGap, {
      filename: "e.csv",
      defaultHost: HOST,
    });

    expect(preview.rows.map((r) => r.status)).toEqual(["ok", "skipped", "ok"]);
    expect(preview.rows[1].input).toBeUndefined();
    expect(preview.rows[1].validation.length).toBeGreaterThan(0);
    expect(preview.summary).toMatchObject({ ready: 2, skipped: 1 });
  });

  /**
   * 307/308 are mapped by *permanence*, which is what a browser caches on, and
   * the loss of method preservation is stated. An absent code defaults to the
   * temporary one: a wrong 302 is retried, a wrong 301 lives on in browser
   * caches long after the rule is fixed. A code with no equivalent is refused
   * rather than invented.
   */
  it.each([
    { source: "301", statusCode: 301, note: undefined },
    { source: "302", statusCode: 302, note: undefined },
    { source: "308", statusCode: 301, note: /308 mapped to 301/ },
    { source: "307", statusCode: 302, note: /307 mapped to 302/ },
    { source: "303", statusCode: 302, note: /303 mapped to 302/ },
    { source: "", statusCode: 302, note: /defaulted to 302/ },
  ])("maps status $source to $statusCode", ({ source, statusCode, note }) => {
    const preview = parseExport(
      `ruleName,matchURL,redirectURL,result.statusCode\nR,/a,/b,${source}`,
      { filename: "e.csv", defaultHost: HOST },
    );
    const row = preview.rows[0];
    expect(asRedirect(row.input).statusCode).toBe(statusCode);
    if (note === undefined) {
      expect(row.status).toBe("ok");
    } else {
      expect(row.status).toBe("warning");
      expect(row.messages.join(" ")).toMatch(note);
    }
  });

  it("refuses a status code with no 301/302 equivalent", () => {
    const preview = parseExport(
      "ruleName,matchURL,redirectURL,result.statusCode\nR,/a,/b,200",
      { filename: "e.csv", defaultHost: HOST },
    );
    expect(preview.rows[0].status).toBe("skipped");
    expect(preview.rows[0].blocked.join(" ")).toMatch(/status code 200/);
  });

  /**
   * Akamai drops the incoming query string unless the rule opts in. The editor's
   * own default is the opposite, because it is the convenient one for a human
   * typing a rule — but an import has to say what the source said.
   */
  it("keeps the query string only when the source column says so", () => {
    const preview = parseExport(
      [
        "ruleName,matchURL,redirectURL,result.statusCode,useIncomingQueryString",
        "Silent,/old-a,/new-a,301,",
        "OptedIn,/old-b,/new-b,301,true",
      ].join("\n"),
      { filename: "e.csv", defaultHost: HOST },
    );

    expect(asRedirect(preview.rows[0].input).useIncomingQueryString).toBe(
      false,
    );
    expect(asRedirect(preview.rows[1].input).useIncomingQueryString).toBe(true);
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

  it("defaults the status to a temporary 302 when the column is absent", () => {
    const preview = parseExport("source,target\n/a,/b", {
      filename: "map.csv",
      defaultHost: HOST,
    });
    // Temporary, not permanent: a guessed 301 would be cached by browsers and
    // outlive the correction.
    expect(asRedirect(preview.rows[0].input).statusCode).toBe(302);
    expect(preview.rows[0].messages.join(" ")).toMatch(/defaulted to 302/);
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
    const preview = parseExport(json, {
      filename: "rules.json",
      defaultHost: HOST,
    });
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
    const preview = parseExport(json, {
      filename: "rules.json",
      defaultHost: HOST,
    });
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
    const preview = parseExport(json, {
      filename: "set.json",
      defaultHost: HOST,
    });
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

  /**
   * Akamai has operators we cannot state — `exists` asks whether the header is
   * there at all. Folding it onto `equals` would import a stricter rule under the
   * same name, so it is refused. An absent operator is not one of those: an
   * export routinely omits it, and it means `equals`.
   */
  it.each([
    { operator: "exists", status: "skipped" },
    { operator: "does_not_exist", status: "skipped" },
    { operator: "contains", status: "ok" },
    { operator: "", status: "ok" },
  ])("refuses operator $operator: $status", ({ operator, status }) => {
    const json = JSON.stringify([
      {
        name: "h",
        redirectURL: "/new",
        statusCode: 301,
        matches: [
          {
            matchType: "header",
            name: "X-Test",
            matchOperator: operator,
            matchValue: "1",
          },
        ],
      },
    ]);
    const preview = parseExport(json, {
      filename: "rules.json",
      defaultHost: HOST,
    });
    expect(preview.rows[0].status).toBe(status);
    if (status === "skipped") {
      expect(preview.rows[0].blocked.join(" ")).toMatch(operator);
    }
  });

  /**
   * A cookie condition names its cookie; a `MatchCondition` cannot hold that
   * name, so the edge would compare the value against the entire `Cookie` header.
   * Refused either way — and the second shape shows why it matters: keeping only
   * the path would redirect everyone instead of the test group.
   */
  it.each([
    { what: "alone", extra: [] as unknown[] },
    {
      what: "next to a path condition",
      extra: [
        { matchType: "path", matchOperator: "equals", matchValue: "/ab" },
      ] as unknown[],
    },
  ])("refuses a cookie condition $what", ({ extra }) => {
    const json = JSON.stringify([
      {
        name: "ab",
        redirectURL: "/variant-b",
        statusCode: 302,
        matches: [
          ...extra,
          {
            matchType: "cookie",
            name: "ab_test",
            matchOperator: "equals",
            matchValue: "on",
          },
        ],
      },
    ]);
    const preview = parseExport(json, {
      filename: "rules.json",
      defaultHost: HOST,
    });
    expect(preview.rows[0].status).toBe("skipped");
    expect(preview.rows[0].blocked.join(" ")).toMatch(/cookie/);
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
    const preview = parseExport(json, {
      filename: "rules.json",
      defaultHost: HOST,
    });
    expect(preview.rows[0].status).toBe("ok");
    expect(asRedirect(preview.rows[0].input).matches[0]).toMatchObject({
      matchType: "header",
      headerName: "X-Country",
    });
  });

  /**
   * Conditions AND together, so a dropped one widens the rule rather than
   * narrowing it. Both shapes are refused: the mixed rule would redirect the
   * POSTs it used to leave alone, and the single-condition one would match every
   * request on the host — a redirect loop when the target sits on that host.
   */
  it.each([
    {
      what: "the only condition",
      matches: [{ matchType: "method", matchValue: "GET" }],
    },
    {
      what: "one condition of several",
      matches: [
        { matchType: "path", matchOperator: "equals", matchValue: "/api" },
        { matchType: "method", matchValue: "GET" },
      ],
    },
  ])(
    "refuses a rule when a condition is $what and cannot be translated",
    ({ matches }) => {
      const json = JSON.stringify([
        { name: "api", redirectURL: "/api/v2", statusCode: 301, matches },
      ]);
      const preview = parseExport(json, {
        filename: "rules.json",
        defaultHost: HOST,
      });
      const row = preview.rows[0];
      expect(row.status).toBe("skipped");
      expect(row.input).toBeUndefined();
      expect(row.blocked.join(" ")).toMatch(/match type "method"/);
      expect(preview.summary).toMatchObject({ ready: 0, skipped: 1 });
    },
  );

  /**
   * `matches` is read as a regular expression, which is what it means in the
   * exports we have seen — but unlike `regex` it does not say so. If an export
   * means it as a wildcard pattern, `*` flips from "anything" to "repeat the
   * previous character" and the rule matches something else entirely, while still
   * importing. The reading stands; the row says to check it.
   */
  it("warns that a `matches` operator was read as a regular expression", () => {
    const json = JSON.stringify([
      {
        name: "m",
        redirectURL: "/new",
        statusCode: 301,
        matches: [
          {
            matchType: "path",
            matchOperator: "matches",
            matchValue: "^/old/.*$",
          },
        ],
      },
    ]);
    const preview = parseExport(json, {
      filename: "rules.json",
      defaultHost: HOST,
    });
    const row = preview.rows[0];

    expect(row.status).toBe("warning");
    expect(row.messages.join(" ")).toMatch(/read as a regular expression/);
    // Warned, not refused, and the value is passed through untranslated.
    expect(asRedirect(row.input).matches[0]).toMatchObject({
      matchOperator: "regex",
      matchValue: "^/old/.*$",
    });
  });

  it("uses matchURL when matches is present but empty", () => {
    const json = JSON.stringify([
      {
        name: "empty",
        matchURL: "/old",
        redirectURL: "/new",
        statusCode: 301,
        matches: [],
      },
    ]);
    const preview = parseExport(json, {
      filename: "rules.json",
      defaultHost: HOST,
    });
    const row = preview.rows[0];
    expect(row.status).toBe("ok");
    expect(asRedirect(row.input).matches).toMatchObject([
      { matchType: "path", matchOperator: "equals", matchValue: "/old" },
    ]);
  });
});

describe("parseExport — Edge Redirector policy CSV", () => {
  const HEADER =
    "policyId,policyName,why,statusCode,redirectURL,useIncomingQueryString," +
    "useRelativeUrl,matchType,matchOperator,matchValue,negate,caseSensitive";

  it("maps a wildcard-capture redirect, translating \\1 to $1", () => {
    // The real Akamai shape: a wildcard match feeding a backreference target.
    // The glob keeps its leading "/" outside the capture, so the target has to
    // carry that "/" itself for the redirect to stay root-relative.
    const csv = `${HEADER}\n5001,P_BE,note,301,/\\1/\\2/,True,,path,contains,/*/*/,False,False`;
    const preview = parseExport(csv, {
      filename: "policy.csv",
      defaultHost: HOST,
    });

    expect(preview.format).toBe("edge-redirector-policy-csv");
    expect(preview.rows).toHaveLength(1);

    const row = preview.rows[0];
    expect(row.status).not.toBe("skipped");
    const input = asRedirect(row.input);
    expect(input.redirectURL).toBe("/$1/$2/");
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

  /**
   * The edge writes the target into `Location` verbatim, so one that starts with
   * a capture taken from *inside* the path builds a path-relative redirect: the
   * two-segment glob below is translated to an anchored regex whose first group
   * opens after the leading "/", so `\1/\2/` on `/a/b/` asks the browser for
   * `a/b/`, which it resolves to `/a/b/a/b/`. Refused rather than imported as a
   * loop — the fix (where the leading "/" goes) is the user's to make, not one
   * the importer can guess.
   */
  it("refuses a capture target that would redirect relative to the path", () => {
    const csv = `${HEADER}\n5001,P_BE,note,301,\\1/\\2/,True,,path,contains,/*/*/,False,False`;
    const preview = parseExport(csv, {
      filename: "policy.csv",
      defaultHost: HOST,
    });

    const row = preview.rows[0];
    expect(row.status).toBe("skipped");
    expect(row.input).toBeUndefined();
    // Translated all the same, so the preview shows what was read.
    expect(row.draft.redirectURL).toBe("$1/$2/");
    expect(row.validation).toEqual([
      {
        path: "/redirectURL",
        message: expect.stringContaining("start of the request"),
      },
    ]);
  });

  /**
   * The same target is fine when the capture starts where the path does: an
   * unanchored `(.*)` matches from index 0, so `$1` carries the leading "/".
   */
  it("keeps a capture target whose group starts at the path's start", () => {
    const pattern = "(.*)\\/([^\\/]+)\\/";
    const csv = `${HEADER}\n5001,P_BE,note,301,\\1/\\2/,True,,path,regex,${pattern},False,False`;
    const preview = parseExport(csv, {
      filename: "policy.csv",
      defaultHost: HOST,
    });

    const row = preview.rows[0];
    expect(row.validation).toEqual([]);
    expect(asRedirect(row.input).redirectURL).toBe("$1/$2/");
    // What the edge will build for /a/b/: root-relative, so no loop.
    const [, one, two] = new RegExp(pattern).exec("/a/b/") ?? [];
    expect(`${one}/${two}/`).toBe("/a/b/");
  });

  it("groups rows sharing a policyId and result into one rule, ANDing their conditions", () => {
    const csv = [
      HEADER,
      "500,Multi,note,302,/dest,,,path,equals,/old,False,False",
      "500,Multi,note,302,/dest,,,hostname,equals,shop.example.com,False,False",
    ].join("\n");
    const preview = parseExport(csv, {
      filename: "policy.csv",
      defaultHost: HOST,
    });

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
    const preview = parseExport(csv, {
      filename: "policy.csv",
      defaultHost: HOST,
    });
    expect(preview.rows).toHaveLength(2);
    expect(preview.rows.map((r) => r.status)).toEqual(["ok", "ok"]);
  });

  /**
   * A policy holds several rules, so the policy id alone cannot identify one.
   * Grouping on it would AND `/a` with `/b` — a rule that imports cleanly and
   * matches nothing — and keep only the first row's target, dropping `/b-dest`
   * with no message at all.
   */
  it("splits a policy's rows into one rule per redirect result", () => {
    const csv = [
      HEADER,
      "500,Multi,note,301,/a-dest,,,path,equals,/a,False,False",
      "500,Multi,note,302,/b-dest,,,path,equals,/b,False,False",
    ].join("\n");
    const preview = parseExport(csv, {
      filename: "policy.csv",
      defaultHost: HOST,
    });

    expect(preview.rows).toHaveLength(2);
    expect(preview.summary.ready).toBe(2);
    const inputs = preview.rows.map((row) => asRedirect(row.input));
    expect(inputs.map((input) => input.redirectURL)).toEqual([
      "/a-dest",
      "/b-dest",
    ]);
    expect(inputs.map((input) => input.statusCode)).toEqual([301, 302]);
    expect(inputs.map((input) => input.matches.length)).toEqual([1, 1]);
    expect(inputs.map((input) => input.matches[0].matchValue)).toEqual([
      "/a",
      "/b",
    ]);
  });

  it("keeps the AND within a rule while a sibling rule stays separate", () => {
    const csv = [
      HEADER,
      "500,Multi,note,301,/a-dest,True,,path,equals,/a,False,False",
      "500,Multi,note,301,/a-dest,True,,protocol,equals,https,False,False",
      "500,Multi,note,302,/b-dest,,,path,equals,/b,False,False",
    ].join("\n");
    const preview = parseExport(csv, {
      filename: "policy.csv",
      defaultHost: HOST,
    });

    expect(preview.rows).toHaveLength(2);
    const [anded, sibling] = preview.rows.map((row) => asRedirect(row.input));
    expect(anded.matches).toHaveLength(2);
    expect(anded.matches.map((match) => match.matchType)).toEqual([
      "path",
      "protocol",
    ]);
    expect(anded.useIncomingQueryString).toBe(true);
    expect(sibling.matches).toHaveLength(1);
    expect(sibling.useIncomingQueryString).toBe(false);
  });

  /**
   * The result is repeated on every row of a rule, including one that carries no
   * criterion — so a result-only row keys to its own rule and joins it, where it
   * is dropped from the conditions rather than becoming an empty match.
   */
  it("keeps a result-only row with the rule it repeats", () => {
    const csv = [
      HEADER,
      "500,Multi,note,301,/dest,,,path,equals,/old,False,False",
      "500,Multi,note,301,/dest,,,,,,,",
    ].join("\n");
    const preview = parseExport(csv, {
      filename: "policy.csv",
      defaultHost: HOST,
    });

    expect(preview.rows).toHaveLength(1);
    const input = asRedirect(preview.rows[0].input);
    expect(input.matches).toHaveLength(1);
    expect(input.matches[0].matchValue).toBe("/old");
  });

  /**
   * A result no other row repeats is a rule of its own: an Edge Redirector
   * default, with no criterion. It used to be the silently discarded one; now it
   * is a visible row, and the shadow check says what an unconditional rule does
   * to the rules imported after it.
   */
  it("reads a result nothing else repeats as an unconditional rule", () => {
    const csv = [
      HEADER,
      "500,Multi,note,301,/fallback,,,,,,,",
      "500,Multi,note,302,/b-dest,,,path,equals,/b,False,False",
    ].join("\n");
    const preview = parseExport(csv, {
      filename: "policy.csv",
      defaultHost: HOST,
    });

    expect(preview.rows).toHaveLength(2);
    const fallback = asRedirect(preview.rows[0].input);
    expect(fallback.redirectURL).toBe("/fallback");
    expect(fallback.matches).toEqual([]);
    expect(preview.rows[0].status).toBe("warning");
    expect(preview.rows[0].messages.join(" ")).toMatch(/matches every request/);
    expect(asRedirect(preview.rows[1].input).redirectURL).toBe("/b-dest");
  });

  /**
   * Grouping is by result, not by adjacency: a file that does not keep a rule's
   * rows together still imports as the rules it describes, rather than having
   * conditions dropped from an AND — which would widen the rule.
   */
  it("regroups rows of one rule the export left apart", () => {
    const csv = [
      HEADER,
      "500,Multi,note,301,/a-dest,,,path,equals,/a,False,False",
      "500,Multi,note,302,/b-dest,,,path,equals,/b,False,False",
      "500,Multi,note,301,/a-dest,,,protocol,equals,https,False,False",
    ].join("\n");
    const preview = parseExport(csv, {
      filename: "policy.csv",
      defaultHost: HOST,
    });

    expect(preview.rows).toHaveLength(2);
    const inputs = preview.rows.map((row) => asRedirect(row.input));
    // Group order follows each rule's first row.
    expect(inputs.map((input) => input.redirectURL)).toEqual([
      "/a-dest",
      "/b-dest",
    ]);
    expect(inputs.map((input) => input.matches.length)).toEqual([2, 1]);
  });

  /** A blank status / query-string cell is blank on every row, so it never splits. */
  it("does not split a rule on blank result cells", () => {
    const csv = [
      HEADER,
      "500,Multi,,,/dest,,,path,equals,/old,False,False",
      "500,Multi,,,/dest,,,protocol,equals,https,False,False",
    ].join("\n");
    const preview = parseExport(csv, {
      filename: "policy.csv",
      defaultHost: HOST,
    });

    expect(preview.rows).toHaveLength(1);
    const row = preview.rows[0];
    expect(row.status).toBe("warning");
    expect(row.messages.join(" ")).toMatch(/defaulted to 302/);
    const input = asRedirect(row.input);
    expect(input.statusCode).toBe(302);
    expect(input.matches).toHaveLength(2);
  });

  it("keeps two policies with the same result apart", () => {
    const csv = [
      HEADER,
      "500,A,note,301,/dest,,,path,equals,/a,False,False",
      "501,B,note,301,/dest,,,path,equals,/b,False,False",
    ].join("\n");
    const preview = parseExport(csv, {
      filename: "policy.csv",
      defaultHost: HOST,
    });

    expect(preview.rows).toHaveLength(2);
    const inputs = preview.rows.map((row) => asRedirect(row.input));
    expect(inputs.map((input) => input.matches.length)).toEqual([1, 1]);
    expect(inputs.map((input) => input.matches[0].matchValue)).toEqual([
      "/a",
      "/b",
    ]);
  });

  it("warns when a target reinjects a capture no condition provides", () => {
    const csv = `${HEADER}\n7,Lost,note,301,/gone/\\1,,,path,equals,/exact,False,False`;
    const preview = parseExport(csv, {
      filename: "policy.csv",
      defaultHost: HOST,
    });
    const row = preview.rows[0];
    expect(row.status).toBe("warning");
    expect(row.messages.join(" ")).toMatch(/reinjects a captured group/);
    expect(asRedirect(row.input).redirectURL).toBe("/gone/$1");
  });

  /**
   * The same rule with the capture in front is refused, not warned: with no
   * regex condition the edge substitutes nothing, so `Location` would be the
   * literal `$1/gone` — a path-relative value on top of a meaningless one.
   */
  it("refuses a leading capture no condition provides", () => {
    const csv = `${HEADER}\n7,Lost,note,301,\\1/gone,,,path,equals,/exact,False,False`;
    const preview = parseExport(csv, {
      filename: "policy.csv",
      defaultHost: HOST,
    });
    const row = preview.rows[0];
    expect(row.status).toBe("skipped");
    expect(row.validation[0].path).toBe("/redirectURL");
  });

  it("keeps space-separated alternatives verbatim for the edge to expand", () => {
    // Akamai's `/ /*` means "/ OR /*" (a catch-all): the edge splits on space
    // and expands each natively. Translating it to one regex would break both
    // the alternatives and the unanchored `contains` semantics.
    const csv =
      `${HEADER}\n42,Catchall,note,301,https://example.com/nl,False,,` +
      `path,contains,/ /*,False,False`;
    const preview = parseExport(csv, {
      filename: "policy.csv",
      defaultHost: HOST,
    });
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
    const preview = parseExport(csv, {
      filename: "policy.csv",
      defaultHost: HOST,
    });
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
          {
            matchType: "hostname",
            matchOperator: "equals",
            matchValue: "support.example.com",
          },
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

  /**
   * A hostname condition is a match, not a name. `*.example.com` or a pair of
   * space-separated alternatives cannot be a partition key — the edge looks up
   * the literal host the viewer sent — so routing them would file the rule under
   * a name no request carries. They stay conditions instead, and say so.
   */
  it.each([
    { what: "a wildcard", value: "*.example.com" },
    { what: "alternatives", value: "shop.example.com help.example.com" },
  ])("keeps a hostname that is $what as a condition", ({ value }) => {
    const json = JSON.stringify([
      {
        name: "h",
        redirectURL: "https://a.example.com/",
        statusCode: 301,
        matches: [
          { matchType: "hostname", matchOperator: "equals", matchValue: value },
        ],
      },
    ]);
    const preview = parseExport(json, {
      filename: "rules.json",
      defaultHost: HOST,
    });
    const row = preview.rows[0];
    expect(row.host).toBe(HOST);
    expect(row.status).toBe("warning");
    expect(row.messages.join(" ")).toMatch(/not a single host/);
    expect(asRedirect(row.input).matches).toMatchObject([
      { matchType: "hostname", matchValue: value },
    ]);
  });

  it("lowercases the host it routes to, so one host stays one partition", () => {
    const json = JSON.stringify([
      {
        name: "h",
        redirectURL: "https://help.example.com",
        statusCode: 301,
        matches: [
          {
            matchType: "hostname",
            matchOperator: "equals",
            matchValue: "Support.Example.COM",
          },
        ],
      },
    ]);
    const preview = parseExport(json, {
      filename: "rules.json",
      defaultHost: HOST,
    });
    expect(preview.rows[0].host).toBe("support.example.com");
    expect(preview.rows[0].status).toBe("ok");
  });

  /**
   * A real export guards on the host two ways: with a `hostname` condition, which
   * names a partition and therefore routes, or with a regex over the full URL,
   * which cannot route because it may describe a pattern of hosts. The second
   * kind lands on the target host and can never match there — it imports
   * cleanly, reads as ok, and does nothing. So it is called out.
   */
  const fullUrlGuard = (pattern: string): string =>
    JSON.stringify([
      {
        name: "domain move",
        redirectURL: "https://www.brand-a.example/nl",
        statusCode: 301,
        matches: [
          { matchType: "path", matchOperator: "contains", matchValue: "/ /*" },
          { matchType: "regex", matchOperator: "equals", matchValue: pattern },
        ],
      },
    ]);

  it("names the host to import into, rather than leaving the regex to read", () => {
    const preview = parseExport(
      fullUrlGuard("https://(www\\.)?www.brand-b.example/.*"),
      { filename: "rules.json", defaultHost: HOST },
    );
    const row = preview.rows[0];
    expect(row.status).toBe("warning");
    // The optional group is dropped and the escapes removed, so the note can
    // name a host the user can pick in the target-host menu.
    expect(row.messages.join(" ")).toBe(
      "this rule only fires on requests to www.brand-b.example, not on " +
        "www.example.com, because its regex compares the whole URL. Select " +
        "www.brand-b.example as the target host to import it.",
    );
  });

  it("falls back to a note with no host when the pattern is unreadable", () => {
    const preview = parseExport(
      fullUrlGuard("https://(a|b)\\.example\\.(com|net)/.*"),
      { filename: "rules.json", defaultHost: HOST },
    );
    const messages = preview.rows[0].messages.join(" ");
    expect(messages).toMatch(/only fires on requests to the host its regex/);
    // Naming the wrong host would be worse than naming none.
    expect(messages).not.toMatch(/Select/);
  });

  it.each([
    { what: "the target host itself", pattern: `https://${HOST}/old/(.*)` },
    {
      what: "an optional www prefix",
      pattern: "https://(www\\.)?example\\.com/.*",
    },
  ])("stays quiet when the pattern accepts $what", ({ pattern }) => {
    const preview = parseExport(fullUrlGuard(pattern), {
      filename: "rules.json",
      defaultHost: pattern.includes("(www") ? "www.example.com" : HOST,
    });
    expect(preview.rows[0].messages.join(" ")).not.toMatch(/never fire/);
  });

  /**
   * `path contains "/ /*"` reads like a filter and is not one: the edge splits on
   * spaces and expands `*`, so it asks "does the path contain `/`, or anything at
   * all". A rule whose every condition is like that wins for every request, and
   * shadows whatever is imported after it on the same host.
   */
  const catchAll = (rows: { name: string; host?: string }[]): string =>
    JSON.stringify(
      rows.map(({ name, host }) => ({
        name,
        redirectURL: `/${name}`,
        statusCode: 301,
        matches: [
          { matchType: "path", matchOperator: "contains", matchValue: "/ /*" },
          ...(host === undefined
            ? []
            : [
                {
                  matchType: "hostname",
                  matchOperator: "equals",
                  matchValue: host,
                },
              ]),
        ],
      })),
    );

  it("warns when a catch-all shadows the rules imported after it", () => {
    const preview = parseExport(
      catchAll([{ name: "first" }, { name: "then" }]),
      {
        filename: "rules.json",
        defaultHost: HOST,
      },
    );

    expect(preview.rows[0].status).toBe("warning");
    expect(preview.rows[0].messages.join(" ")).toMatch(
      /matches every request, so the rules imported after it/,
    );
    // The last one shadows nothing, so it says nothing.
    expect(preview.rows[1].messages.join(" ")).not.toMatch(/every request/);
  });

  /**
   * `equals` is anchored, so `/` is the homepage and nothing else. That row opens
   * nearly every redirect map, and reading it as a catch-all would put a false
   * "shadows everything after it" on almost every import — and move the row out
   * of the `ok` count for good measure.
   */
  it.each([
    { what: "the homepage", value: "/", shadows: false },
    { what: "everything under the root", value: "/*", shadows: true },
    { what: "any path at all", value: "*", shadows: true },
  ])("an `equals $value` matches $what", ({ value, shadows }) => {
    const preview = parseExport(
      `source,target,statusCode\n${value},/home,301\n/old,/new,301\n`,
      {
        filename: "map.csv",
        defaultHost: HOST,
      },
    );

    expect(preview.rows[0].messages.join(" ")).toMatch(
      shadows ? /matches every request/ : /^$/,
    );
    expect(preview.rows[0].status).toBe(shadows ? "warning" : "ok");
  });

  it("counts shadowing per host, not across the file", () => {
    // The catch-all is first in the file but last on its own host, so it hides
    // nothing: the rule after it lands on a different partition.
    const preview = parseExport(
      catchAll([
        { name: "other-host", host: "shop.example.com" },
        { name: "here" },
      ]),
      { filename: "rules.json", defaultHost: HOST },
    );

    expect(preview.rows[0].host).toBe("shop.example.com");
    expect(preview.rows[0].messages.join(" ")).not.toMatch(/every request/);
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
      {
        policyId: 1001,
        policyName: "A",
        ruleCount: 12,
        source: "akamai-property-export",
      },
      {
        policyId: 1002,
        policyName: "B",
        ruleCount: 8,
        source: "akamai-property-export",
      },
    ]);
    const preview = parseExport(json, {
      filename: "policies.json",
      defaultHost: HOST,
    });
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
            matches: [
              { matchType: "path", matchOperator: "equals", matchValue: "/a" },
            ],
          },
        },
      ],
    });
    const preview = parseExport(json, {
      filename: "set.json",
      defaultHost: HOST,
    });
    expect(preview.rows).toHaveLength(1);
    expect(preview.rows[0].status).not.toBe("skipped");
  });
});

describe("parseExport — Akamai construct coverage (golden, anonymised)", () => {
  // Real Edge Redirector constructs, wrapped as the validation set ships them,
  // with all client identifiers replaced. These pin the mapping so a future
  // refactor cannot silently regress on the shapes that actually occur.
  const wrap = (rule: object): string =>
    JSON.stringify({
      rules: [{ policyId: 9001, policyName: "P", why: [], rule }],
    });

  it("strips a suffix via a capturing regex while the path guard stays verbatim", () => {
    const preview = parseExport(
      wrap({
        type: "erMatchRule",
        name: null,
        matches: [
          {
            matchType: "path",
            matchOperator: "contains",
            matchValue: "/f/*",
            negate: false,
            caseSensitive: false,
          },
          {
            matchType: "regex",
            matchOperator: "equals",
            matchValue: "/f/(.*)/travel-advice",
            negate: false,
            caseSensitive: false,
          },
        ],
        statusCode: 301,
        redirectURL: "/f/\\1",
        useIncomingQueryString: false,
      }),
      { filename: "set.json", defaultHost: HOST },
    );
    const input = asRedirect(preview.rows[0].input);
    expect(input.redirectURL).toBe("/f/$1");
    expect(input.useIncomingQueryString).toBe(false);
    expect(input.matches[0]).toMatchObject({
      matchType: "path",
      matchOperator: "contains",
      matchValue: "/f/*",
    });
    expect(input.matches[1]).toMatchObject({
      matchType: "regex",
      matchOperator: "regex",
      matchValue: "/f/(.*)/travel-advice",
    });
  });

  it("maps a catch-all with a full-URL host guard to a static redirect", () => {
    const preview = parseExport(
      wrap({
        type: "erMatchRule",
        name: "Everything else",
        matches: [
          {
            matchType: "path",
            matchOperator: "contains",
            matchValue: "/ /*",
            negate: false,
            caseSensitive: false,
          },
          {
            matchType: "regex",
            matchOperator: "equals",
            matchValue: "https://(www\\.)?old.example.com/.*",
            negate: false,
            caseSensitive: false,
          },
        ],
        statusCode: 301,
        redirectURL: "https://new.example.com/nl",
        useIncomingQueryString: false,
      }),
      { filename: "set.json", defaultHost: HOST },
    );
    const row = preview.rows[0];
    expect(row.status).not.toBe("skipped");
    const input = asRedirect(row.input);
    expect(input.redirectURL).toBe("https://new.example.com/nl");
    expect(input.matches[0]).toMatchObject({
      matchOperator: "contains",
      matchValue: "/ /*",
    });
    expect(input.matches[1]).toMatchObject({
      matchType: "regex",
      matchOperator: "regex",
    });
    // This is the domain-move shape: the old host lives in the regex, not in a
    // `hostname` condition, so the rule lands on the target host and can never
    // match there. Importable, but only useful imported into `old.example.com`,
    // which is what the note has to say.
    expect(row.messages.join(" ")).toMatch(
      /only fires on requests to old.example.com, not on www.example.com/,
    );
  });
});

describe("parseExport — ReDoS guard", () => {
  it("skips a rule whose regex is potentially catastrophic", () => {
    const json = JSON.stringify([
      {
        type: "erMatchRule",
        name: "bad",
        redirectURL: "/x",
        statusCode: 301,
        matches: [
          { matchType: "regex", matchOperator: "equals", matchValue: "(a+)+$" },
        ],
      },
    ]);
    const preview = parseExport(json, {
      filename: "r.json",
      defaultHost: HOST,
    });
    const row = preview.rows[0];
    expect(row.status).toBe("skipped");
    expect(row.validation.map((d) => d.message).join(" ")).toMatch(
      /catastrophic|ReDoS/i,
    );
  });

  it("allows a normal capturing regex", () => {
    const json = JSON.stringify([
      {
        type: "erMatchRule",
        name: "ok",
        redirectURL: "/f/$1",
        statusCode: 301,
        matches: [
          {
            matchType: "regex",
            matchOperator: "equals",
            matchValue: "/f/(.*)/x",
          },
        ],
      },
    ]);
    const preview = parseExport(json, {
      filename: "r.json",
      defaultHost: HOST,
    });
    expect(preview.rows[0].status).not.toBe("skipped");
  });
});

describe("parseExport — size guards", () => {
  it("rejects an oversized import instead of parsing it", () => {
    const huge = "x".repeat(10 * 1024 * 1024 + 1);
    const preview = parseExport(huge, {
      filename: "big.csv",
      defaultHost: HOST,
    });
    expect(preview.rows).toEqual([]);
    expect(preview.error).toMatch(/too large/i);
  });

  /**
   * Bytes bound the parse, rule count bounds everything after it: the mapping,
   * the rows on the page, and one HTTP request per rule at import time. A file
   * can be small and still ask for far too much.
   */
  it("rejects an import with more rules than one batch should carry", () => {
    const rows = ["source,target"];
    for (let i = 0; i < 5001; i++) rows.push(`/old-${i},/new-${i}`);
    const preview = parseExport(rows.join("\n"), {
      filename: "many.csv",
      defaultHost: HOST,
    });
    expect(preview.rows).toEqual([]);
    expect(preview.error).toMatch(/5001 rules \(limit 5000\)/);
  });

  it("accepts a batch at the limit", () => {
    const rows = ["source,target"];
    for (let i = 0; i < 5000; i++) rows.push(`/old-${i},/new-${i}`);
    const preview = parseExport(rows.join("\n"), {
      filename: "many.csv",
      defaultHost: HOST,
    });
    expect(preview.error).toBeUndefined();
    expect(preview.rows).toHaveLength(5000);
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
