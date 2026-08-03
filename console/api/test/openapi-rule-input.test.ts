import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import redirectSchema from "@cloudfront-redirect-rules/shared/redirect-rule.schema.json" with { type: "json" };
import rewriteSchema from "@cloudfront-redirect-rules/shared/rewrite-rule.schema.json" with { type: "json" };
import { PRIORITY_MAX, PRIORITY_MIN } from "../src/lib/rule-keys.js";

/**
 * `RuleInput` is the one rule shape restated outside `shared/`: the request body
 * has no `sk` yet and carries a `priority` the stored item must never have, and
 * draft-07 cannot express that as a `$ref` to the shared schemas. So the field
 * list is hand-written — and nothing but this test stops it drifting from the
 * schemas the API actually validates against, which is how the SPA (ER-301) ends
 * up with a generated client that omits a field the server requires, or rejects
 * a value the server accepts.
 *
 * The relationship it pins, for each rule type:
 *   input properties == item properties + priority
 *   input required   == item required - pk - sk + priority
 *   every field not `$ref`-ing shared/ is defined identically to it
 */

interface JsonSchema {
  properties?: Record<string, unknown>;
  required?: string[];
}

/**
 * Fields whose definitions cannot drift and so are not compared: the two keys
 * and `priority` exist only on one side by design, while `matches` and
 * `forwardSettings` are `$ref`s into `shared/` — copying those structures is
 * exactly what the spec avoids.
 */
const NOT_COMPARABLE = new Set([
  "pk",
  "sk",
  "priority",
  "matches",
  "forwardSettings",
]);

const at = (node: unknown, key: string): unknown =>
  typeof node === "object" && node !== null
    ? (node as Record<string, unknown>)[key]
    : undefined;

/** The `$ref` a property carries, directly or through its array `items`. */
const refIn = (definition: unknown): unknown =>
  at(definition, "$ref") ?? at(at(definition, "items"), "$ref");

/**
 * Follows a `$ref` into the shared schema it names. `redocly lint` rejects a
 * *broken* pointer but is perfectly happy with a valid one aimed at the wrong
 * subschema, which is the failure this makes visible.
 */
const resolveRef = (ref: unknown): unknown => {
  if (typeof ref !== "string") return undefined;

  const [file = "", pointer = ""] = ref.split("#");
  const schema: unknown = file.includes("rewrite-rule")
    ? rewriteSchema
    : redirectSchema;

  return pointer.split("/").filter(Boolean).reduce<unknown>(at, schema);
};

/** Prose differs freely between a request schema and an item schema. */
const withoutProse = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutProse);
  if (typeof value !== "object" || value === null) return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "description" && key !== "$comment")
      .map(([key, nested]) => [key, withoutProse(nested)]),
  );
};

const spec = parse(
  readFileSync(
    fileURLToPath(new URL("../openapi.yaml", import.meta.url)),
    "utf8",
  ),
) as { components: { schemas: Record<string, JsonSchema> } };

const sorted = (values: Iterable<string>): string[] => [...values].sort();

const cases = [
  ["RedirectRuleInput", redirectSchema as JsonSchema],
  ["RewriteRuleInput", rewriteSchema as JsonSchema],
] as const;

describe.each(cases)("%s matches the shared schema", (name, shared) => {
  const input = spec.components.schemas[name];

  it("is published at all", () => {
    // Guards every comparison below: a renamed schema would otherwise make each
    // one compare undefined against undefined.
    expect(input, `${name} is missing from openapi.yaml`).toBeDefined();
    expect(Object.keys(shared.properties ?? {}).length).toBeGreaterThan(0);
  });

  it("offers exactly the item's fields plus priority", () => {
    expect(sorted(Object.keys(input?.properties ?? {}))).toEqual(
      sorted([...Object.keys(shared.properties ?? {}), "priority"]),
    );
  });

  it("requires the item's fields, less the server-owned keys, plus priority", () => {
    const expected = (shared.required ?? [])
      .filter((field) => field !== "pk" && field !== "sk")
      .concat("priority");

    expect(sorted(input?.required ?? [])).toEqual(sorted(expected));
  });

  it("rejects unknown fields, as the item schema does", () => {
    // Without this a typo'd field is accepted by the published contract and then
    // rejected by the server, which validates the composed item.
    expect(input).toMatchObject({ additionalProperties: false });
  });

  it("defines every hand-copied field exactly as the item schema does", () => {
    // The field names matching is not enough: `statusCode`'s enum and
    // `redirectURL`'s minLength are copied values. Widen the shared enum in
    // ER-204 and, without this, the server would accept a status code the
    // generated client refuses to send.
    for (const [field, definition] of Object.entries(input?.properties ?? {})) {
      if (NOT_COMPARABLE.has(field)) continue;

      expect(
        withoutProse(definition),
        `${name}.${field} has drifted from the shared schema`,
      ).toEqual(withoutProse(shared.properties?.[field]));
    }
  });
});

/**
 * The fields excluded from the comparison above are excluded because they `$ref`
 * into `shared/` instead of restating it — so that is worth checking too. Each
 * pointer must land on the subschema it is meant to reuse, not merely on
 * something that exists.
 */
describe("nested structures reuse the shared schemas", () => {
  const cases: [string, string, unknown][] = [
    ["RedirectRuleInput", "matches", redirectSchema.definitions.match],
    // The rewrite schema has no `match` definition of its own; both inputs share
    // the redirect schema's, exactly as the item schemas do.
    ["RewriteRuleInput", "matches", redirectSchema.definitions.match],
    [
      "RewriteRuleInput",
      "forwardSettings",
      rewriteSchema.properties.forwardSettings,
    ],
  ];

  it.each(cases)(
    "%s.%s resolves to the shared subschema",
    (name, field, expected) => {
      const ref = refIn(spec.components.schemas[name]?.properties?.[field]);

      expect(ref, `${name}.${field} does not $ref shared/`).toEqual(
        expect.any(String),
      );
      expect(resolveRef(ref)).toEqual(expected);
    },
  );
});

describe("RulePriority", () => {
  const priority = spec.components.schemas["RulePriority"] as {
    minimum?: number;
    maximum?: number;
  };

  it("publishes the range the sort key can actually represent", () => {
    // The spec justifies the bound by the key width, so it has to be the width
    // the server enforces — not a number that happened to match when written.
    expect(priority?.minimum).toBe(PRIORITY_MIN);
    expect(priority?.maximum).toBe(PRIORITY_MAX);
  });
});
