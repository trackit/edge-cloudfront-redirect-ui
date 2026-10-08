import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { draftFromRule, validateDraft } from "../src/domain/ruleDraft";
import type { RewriteDraft } from "../src/domain/ruleDraft";
import type { Rule } from "../src/api";

/**
 * The form and the schema have to agree about a rewrite's path and origin.
 *
 * Same contract as redirect-target-contract.test.ts, for CF-53's fields: the
 * form's checks in `validateDraft` and the patterns in
 * shared/rewrite-rule.schema.json are written separately, so this asserts that
 * **anything the form accepts, the schema accepts** — otherwise the user is
 * shown the raw regex from the API instead of the form's message.
 */

interface Schema {
  properties: {
    forwardSettings: { properties: { pathAndQS: { pattern: string } } };
  };
  definitions: {
    originPath: { pattern: string };
    s3Origin: { properties: { domainName: { pattern: string } } };
    customOrigin: { properties: { domainName: { pattern: string } } };
  };
}

const schema = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../../shared/rewrite-rule.schema.json", import.meta.url),
    ),
    "utf8",
  ),
) as Schema;

const matches = (pattern: string, value: string): boolean =>
  new RegExp(pattern, "u").test(value);

const rule = (): Rule =>
  ({
    pk: "www.example.com",
    sk: "REWRITE#00100",
    type: "frMatchRule",
    matches: [
      { matchType: "path", matchOperator: "regex", matchValue: "^/(.*)$" },
    ],
    forwardSettings: { pathAndQS: "/x", useIncomingQueryString: true },
  }) as Rule;

const base = (): RewriteDraft => draftFromRule(rule()) as RewriteDraft;

const formAccepts = (draft: RewriteDraft, path: string): boolean =>
  !validateDraft(draft, []).some((d) => d.path === path);

const SAMPLES = [
  "",
  "/",
  "/v1",
  "/v1/",
  "v1",
  "/a b",
  "$1",
  "$1/x",
  "$0",
  "?x=1",
  "api.example.com",
  "API.example.com",
  "localhost",
  "https://api.example.com",
  "api.example.com:8443",
  "203.0.113.10",
  "-bad.example.com",
  "bucket.s3.eu-west-1.amazonaws.com",
  "a..b",
  "/page?x=1#top",
  "/a\u0001b",
  "/a\u007fb",
];

describe("the form never accepts a rewrite value the schema refuses", () => {
  it.each(SAMPLES)("rewritten path %j", (value) => {
    const draft = { ...base(), pathAndQS: value };
    if (
      value.trim() === "" ||
      !formAccepts(draft, "/forwardSettings/pathAndQS")
    )
      return;
    expect(
      matches(
        schema.properties.forwardSettings.properties.pathAndQS.pattern,
        value,
      ),
    ).toBe(true);
  });

  it.each(SAMPLES)("custom origin domain name and path %j", (value) => {
    const draft: RewriteDraft = {
      ...base(),
      originKind: "custom",
      custom: { ...base().custom, domainName: value, path: value },
    };
    const custom = schema.definitions.customOrigin.properties;
    if (formAccepts(draft, "/forwardSettings/origin/custom/domainName")) {
      expect(matches(custom.domainName.pattern, value)).toBe(true);
    }
    if (formAccepts(draft, "/forwardSettings/origin/custom/path")) {
      expect(matches(schema.definitions.originPath.pattern, value)).toBe(true);
    }
  });

  it.each(SAMPLES)("s3 origin domain name and path %j", (value) => {
    const draft: RewriteDraft = {
      ...base(),
      originKind: "s3",
      s3: { ...base().s3, domainName: value, path: value },
    };
    const s3 = schema.definitions.s3Origin.properties;
    if (formAccepts(draft, "/forwardSettings/origin/s3/domainName")) {
      expect(matches(s3.domainName.pattern, value)).toBe(true);
    }
    if (formAccepts(draft, "/forwardSettings/origin/s3/path")) {
      expect(matches(schema.definitions.originPath.pattern, value)).toBe(true);
    }
  });
});
