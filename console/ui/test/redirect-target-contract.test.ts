import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { draftFromRule, validateDraft } from "../src/ruleDraft";
import type { RedirectDraft } from "../src/ruleDraft";
import type { Rule } from "../src/api";

/**
 * The form and the schema have to agree about `redirectURL`.
 *
 * They are two hand-written checks on one field: `validateDraft` in the browser,
 * `redirectURL.pattern` in shared/redirect-rule.schema.json at the API. Nothing
 * makes them agree, and when they drifted the symptom was a rule the console
 * offered and the API refused with the raw regex in the message — which is
 * exactly what CF-38 set out to stop happening.
 *
 * So this asserts the direction that matters: **anything the form accepts, the
 * schema accepts.** The other direction is fine and deliberate — the form may be
 * stricter, and is (it knows which condition fills a capture; a pattern cannot).
 */

const SCHEMA_PATTERN: string = (
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL("../../../shared/redirect-rule.schema.json", import.meta.url),
      ),
      "utf8",
    ),
  ) as { properties: { redirectURL: { pattern: string } } }
).properties.redirectURL.pattern;

const schemaAccepts = (target: string): boolean =>
  new RegExp(SCHEMA_PATTERN).test(target);

const redirectRule = (over: Partial<Rule> = {}): Rule =>
  ({
    pk: "www.example.com",
    sk: "REDIRECT#00100",
    type: "erMatchRule",
    statusCode: 301,
    redirectURL: "https://www.example.com/new",
    matches: [
      // A group that opens where the path does, so a leading `$1` is legitimate
      // — the case the schema had to be widened for.
      {
        matchType: "path",
        matchOperator: "regex",
        matchValue: "^(.*)/([^/]+)/$",
      },
    ],
    ...over,
  }) as Rule;

const withTarget = (redirectURL: string): RedirectDraft => {
  const draft = draftFromRule(redirectRule()) as RedirectDraft;
  return { ...draft, redirectURL };
};

const formAccepts = (target: string): boolean =>
  !validateDraft(withTarget(target), []).some(
    (detail) => detail.path === "/redirectURL",
  );

/**
 * Both forms of a hand-written target, and the shapes an Akamai import produces
 * (CF-20) — `$1/$2/` and friends, whose leading segment only exists once the
 * edge substitutes the capture.
 */
const TARGETS = [
  "https://www.example.com/new",
  "HTTPS://www.example.com/new",
  "/new",
  "/",
  "/a//b",
  "/archive/$1",
  "/$1/$2/",
  "$1/$2/",
  "$1/gone",
  "$1",
  "$10/x",
  // Ones both should refuse. Listed here too: the assertion is about agreement,
  // and a target the form rejects is allowed to be rejected by either.
  "not a url",
  "new/landing",
  "//evil.example.com/phish",
  "/\\evil.example.com",
  "$1//evil.example.com",
  "$0/x",
  "https://",
  "https://www.example.com/a b",
  "$1/a b",
];

describe("redirectURL: the form and the shared schema", () => {
  it.each(TARGETS)("never lets the form accept %j alone", (target) => {
    if (!formAccepts(target)) return;

    expect(
      schemaAccepts(target),
      `the form accepts ${JSON.stringify(target)} but redirectURL.pattern refuses it — ` +
        "the API would answer 400 with the raw pattern in the message",
    ).toBe(true);
  });

  it("is testing something — the list covers both verdicts", () => {
    // Guards the `return` above: if every target were rejected by the form, the
    // assertion would never run and this suite would pass while checking nothing.
    const accepted = TARGETS.filter(formAccepts);
    expect(accepted.length).toBeGreaterThan(0);
    expect(accepted.length).toBeLessThan(TARGETS.length);
  });
});
