import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { routes } from "../src/routes.js";

/**
 * API Gateway forwards every request to the Lambda through a single `$default`
 * route, so the deployed API is whatever `routes.ts` says — `openapi.yaml` is a
 * separate hand-written document. `redocly lint` only checks the spec is a valid
 * OpenAPI file; it never reads the code. Nothing else stops the two drifting,
 * and the console UI (ER-301) is expected to generate its client from the spec.
 */

const HTTP_METHODS = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
] as const;

interface PathItem {
  [method: string]: unknown;
}

const spec = parse(
  readFileSync(
    fileURLToPath(new URL("../openapi.yaml", import.meta.url)),
    "utf8",
  ),
) as { paths: Record<string, PathItem> };

// OpenAPI writes params as `{name}`, the router as `:name`.
const toRoutePattern = (path: string): string =>
  path.replace(/\{(\w+)\}/g, ":$1");

const specOperations = Object.entries(spec.paths).flatMap(([path, item]) =>
  Object.keys(item)
    .filter((key) =>
      HTTP_METHODS.includes(key as (typeof HTTP_METHODS)[number]),
    )
    .map((method) => `${method.toUpperCase()} ${toRoutePattern(path)}`),
);

const codeOperations = routes.map(
  (route) => `${route.method.toUpperCase()} ${route.pattern}`,
);

describe("openapi.yaml matches the route table", () => {
  it("documents every route the API actually serves", () => {
    const undocumented = codeOperations.filter(
      (op) => !specOperations.includes(op),
    );

    expect(
      undocumented,
      `in routes.ts but missing from openapi.yaml: ${undocumented.join(", ")}`,
    ).toEqual([]);
  });

  it("serves every route it documents", () => {
    const unimplemented = specOperations.filter(
      (op) => !codeOperations.includes(op),
    );

    expect(
      unimplemented,
      `in openapi.yaml but missing from routes.ts: ${unimplemented.join(", ")}`,
    ).toEqual([]);
  });

  it("reads a non-empty spec", () => {
    // Guards the two checks above: if the spec failed to parse into paths, both
    // would compare empty lists and pass without testing anything.
    expect(specOperations.length).toBeGreaterThan(0);
  });
});
