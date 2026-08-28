import { describe, expect, it } from "vitest";
import {
  convertRedirectUrl,
  draftFromRule,
  labelForPath,
  pickSslProtocol,
  toRuleInput,
  validateDraft,
} from "../src/ruleDraft";
import type { CustomDraft, RewriteDraft } from "../src/ruleDraft";
import type { CustomOrigin, Rule, ValidationDetail } from "../src/api";

/**
 * `ruleDraft` is the only place a stored rule becomes the editor's form and back
 * again. A `PUT` replaces the whole item, so the danger is not a wrong value but
 * a dropped one: a field `draftFromRule` fails to read is a field `toRuleInput`
 * then overwrites with a blank. The round-trip cases below are the guard for
 * exactly that, and the validation cases pin the ranges the API would otherwise
 * be left to reject.
 */

const match = (over: Partial<Rule["matches"][number]> = {}) => ({
  matchType: "path" as const,
  matchOperator: "equals" as const,
  matchValue: "/old",
  negate: false,
  caseSensitive: false,
  ...over,
});

const redirectRule = (over: Partial<Rule> = {}): Rule =>
  ({
    pk: "www.example.com",
    sk: "REDIRECT#00100",
    type: "erMatchRule",
    statusCode: 301,
    redirectURL: "https://www.example.com/new",
    useIncomingQueryString: true,
    matches: [match()],
    ...over,
  }) as Rule;

/** Headers set on an origin, e.g. an auth header the backend requires. */
const CUSTOM_HEADERS: CustomOrigin["customHeaders"] = {
  "X-From-CDN": [{ key: "X-From-CDN", value: "s3cr3t" }],
};

const customRewriteRule = (over: Partial<CustomOrigin> = {}): Rule =>
  ({
    pk: "www.example.com",
    sk: "REWRITE#00100",
    type: "frMatchRule",
    matches: [match()],
    forwardSettings: {
      origin: {
        custom: {
          domainName: "api.internal",
          path: "/v1",
          port: 8443,
          protocol: "https-only",
          readTimeout: 30,
          keepaliveTimeout: 5,
          // Two versions on purpose: the editor shows one, but must not narrow
          // the stored set to it.
          sslProtocols: ["TLSv1.2", "TLSv1.1"],
          customHeaders: CUSTOM_HEADERS,
          ...over,
        },
      },
      pathAndQS: "/v1",
      useIncomingQueryString: true,
    },
  }) as Rule;

const s3RewriteRule = (): Rule =>
  ({
    pk: "www.example.com",
    sk: "REWRITE#00200",
    type: "frMatchRule",
    matches: [match()],
    forwardSettings: {
      origin: {
        s3: {
          authMethod: "origin-access-identity",
          region: "eu-west-3",
          domainName: "bucket.s3.eu-west-3.amazonaws.com",
          path: "",
          customHeaders: CUSTOM_HEADERS,
        },
      },
      useIncomingQueryString: false,
    },
  }) as Rule;

const has = (details: ValidationDetail[], path: string): boolean =>
  details.some((d) => d.path === path);

describe("draftFromRule", () => {
  it("reads a redirect, deriving the priority from the sort key", () => {
    const draft = draftFromRule(redirectRule({ sk: "REDIRECT#00042" }));

    expect(draft).toMatchObject({
      kind: "redirect",
      priority: "42",
      statusCode: 301,
      redirectURL: "https://www.example.com/new",
      // Absolute URL, so the "relative" toggle loads off.
      relative: false,
      keepQueryString: true,
      disabled: false,
    });
  });

  it("marks a disabled rule disabled, and a relative URL relative", () => {
    const draft = draftFromRule(
      redirectRule({ disabled: true, redirectURL: "/local" }),
    );
    expect(draft.disabled).toBe(true);
    expect((draft as { relative: boolean }).relative).toBe(true);
  });

  it("carries a custom origin's headers and full sslProtocols array", () => {
    const draft = draftFromRule(customRewriteRule()) as RewriteDraft;

    expect(draft).toMatchObject({
      originKind: "custom",
      custom: {
        // The two fields a PUT would otherwise drop.
        customHeaders: CUSTOM_HEADERS,
        sslProtocols: ["TLSv1.2", "TLSv1.1"],
        // Numbers become strings — an <input> holds text, and "" must stay "".
        port: "8443",
      },
    });
  });

  it("carries an S3 origin's region and headers", () => {
    const draft = draftFromRule(s3RewriteRule()) as RewriteDraft;

    expect(draft).toMatchObject({
      originKind: "s3",
      s3: { region: "eu-west-3", customHeaders: CUSTOM_HEADERS },
    });
  });
});

describe("toRuleInput", () => {
  it("sends neither pk nor sk — the server owns both keys", () => {
    const input = toRuleInput(draftFromRule(redirectRule()));
    expect(input).not.toHaveProperty("pk");
    expect(input).not.toHaveProperty("sk");
  });

  it("omits disabled when the rule is enabled, and sends it when not", () => {
    expect(toRuleInput(draftFromRule(redirectRule()))).not.toHaveProperty(
      "disabled",
    );
    expect(
      toRuleInput(draftFromRule(redirectRule({ disabled: true }))),
    ).toMatchObject({ disabled: true });
  });
});

describe("round-trip (draftFromRule → toRuleInput)", () => {
  it("preserves a custom origin's headers, every TLS version, and the port", () => {
    // Editing the priority (or anything) must not blank these.
    expect(toRuleInput(draftFromRule(customRewriteRule()))).toMatchObject({
      forwardSettings: {
        origin: {
          custom: {
            customHeaders: CUSTOM_HEADERS,
            sslProtocols: ["TLSv1.2", "TLSv1.1"],
            port: 8443,
          },
        },
      },
    });
  });

  it("preserves an S3 origin's region and headers", () => {
    expect(toRuleInput(draftFromRule(s3RewriteRule()))).toMatchObject({
      forwardSettings: {
        origin: { s3: { region: "eu-west-3", customHeaders: CUSTOM_HEADERS } },
      },
    });
  });

  it("narrows sslProtocols only when the user picks one", () => {
    const draft = draftFromRule(customRewriteRule()) as RewriteDraft;
    // Simulate the dropdown's onChange: a pick replaces the array with one.
    const picked: RewriteDraft = {
      ...draft,
      custom: { ...draft.custom, sslProtocols: ["TLSv1.1"] },
    };

    expect(toRuleInput(picked)).toMatchObject({
      forwardSettings: { origin: { custom: { sslProtocols: ["TLSv1.1"] } } },
    });
  });
});

describe("validateDraft — regex", () => {
  const withMatch = (over: Partial<Rule["matches"][number]>): RewriteDraft => {
    const draft = draftFromRule(customRewriteRule()) as RewriteDraft;
    return { ...draft, matches: [match(over)] };
  };

  it.each([
    // The gap the fix closed is the second row: type regex, operator equals.
    ["the operator is regex", { matchOperator: "regex" as const }],
    [
      "only the match type is regex",
      { matchType: "regex" as const, matchOperator: "equals" as const },
    ],
  ])("rejects an invalid pattern when %s", (_case, over) => {
    const details = validateDraft(withMatch({ ...over, matchValue: "[" }), []);
    expect(has(details, "/matches/0/matchValue")).toBe(true);
  });

  it("accepts a valid pattern", () => {
    const details = validateDraft(
      withMatch({ matchType: "regex", matchValue: "^/blog/[0-9]+$" }),
      [],
    );
    expect(has(details, "/matches/0/matchValue")).toBe(false);
  });
});

describe("validateDraft — custom origin ranges", () => {
  const withCustom = (over: Partial<CustomDraft>): RewriteDraft => {
    const draft = draftFromRule(customRewriteRule()) as RewriteDraft;
    return { ...draft, custom: { ...draft.custom, ...over } };
  };

  it.each([
    ["port", "0", true],
    ["port", "65536", true],
    ["port", "443", false],
    ["readTimeout", "0", true],
    ["readTimeout", "-5", true],
    ["readTimeout", "30", false],
    ["keepaliveTimeout", "0", true],
    ["keepaliveTimeout", "5", false],
  ] as const)("%s of %s is invalid: %s", (field, value, invalid) => {
    const details = validateDraft(withCustom({ [field]: value }), []);
    expect(has(details, `/forwardSettings/origin/custom/${field}`)).toBe(
      invalid,
    );
  });
});

describe("validateDraft — priority", () => {
  const withPriority = (priority: string): RewriteDraft => ({
    ...(draftFromRule(customRewriteRule()) as RewriteDraft),
    priority,
  });

  it("requires a priority", () => {
    expect(has(validateDraft(withPriority(""), []), "/priority")).toBe(true);
  });

  it.each([
    ["taken by another rule of this type", "100", [100], true],
    ["free on this type", "100", [200], false],
  ])("is %s", (_case, priority, taken, rejected) => {
    expect(has(validateDraft(withPriority(priority), taken), "/priority")).toBe(
      rejected,
    );
  });
});

describe("convertRedirectUrl", () => {
  it("strips the scheme and host going relative", () => {
    expect(convertRedirectUrl("https://h/x?y=1", true, "h")).toBe("/x?y=1");
  });

  it("puts the host back going absolute", () => {
    expect(convertRedirectUrl("/x", false, "h")).toBe("https://h/x");
  });
});

describe("pickSslProtocol", () => {
  it.each([
    [["TLSv1.1", "TLSv1.2"], "TLSv1.2"],
    [["TLSv1"], "TLSv1"],
    // Nothing recognised (or nothing at all) falls back to the safe default.
    [[], "TLSv1.2"],
  ] as const)("picks the strongest of %j", (stored, strongest) => {
    expect(pickSslProtocol([...stored])).toBe(strongest);
  });
});

describe("labelForPath", () => {
  it.each([
    ["/priority", "Priority"],
    ["/matches/0/matchValue", "Condition 1 value"],
    ["/matches/2/headerName", "Condition 3 header name"],
    // A server path this UI does not produce is shown, not hidden.
    ["/something/else", "/something/else"],
  ])("maps %s to %s", (path, label) => {
    expect(labelForPath(path)).toBe(label);
  });
});
