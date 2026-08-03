import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ERROR_CODES } from "../src/lib/errors.js";

/**
 * The SPA (ER-301) generates its client from `openapi.yaml`, so `error.code` is
 * a published contract. Nothing else connects the enum in the spec to the codes
 * the code actually emits — a renamed code would break the SPA at runtime with no
 * spec diff and no type error. Same idea as openapi-routes.test.ts, for codes.
 */

interface Spec {
  components: {
    schemas: {
      Error: {
        properties: {
          error: { properties: { code: { enum?: string[] } } };
        };
      };
    };
  };
}

const spec = parse(
  readFileSync(
    fileURLToPath(new URL("../openapi.yaml", import.meta.url)),
    "utf8",
  ),
) as Spec;

const specCodes =
  spec.components.schemas.Error.properties.error.properties.code.enum;

describe("openapi.yaml error codes match ERROR_CODES", () => {
  it("publishes an enum at all", () => {
    // Guards the comparison below: without an enum a generated client gets a
    // bare string and both directions would compare against undefined.
    expect(specCodes).toBeDefined();
  });

  it("publishes every code the API can emit", () => {
    const missing = ERROR_CODES.filter((code) => !specCodes?.includes(code));

    expect(
      missing,
      `emitted by errors.ts but missing from openapi.yaml: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("publishes no code the API cannot emit", () => {
    const extra = (specCodes ?? []).filter(
      (code) => !(ERROR_CODES as readonly string[]).includes(code),
    );

    expect(
      extra,
      `in openapi.yaml but not emitted by errors.ts: ${extra.join(", ")}`,
    ).toEqual([]);
  });
});
