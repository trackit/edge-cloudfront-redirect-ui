/**
 * Validates every item in shared/examples/ against its schema.
 * Redirect items (sk REDIRECT#...) -> redirect-rule.schema.json
 * Rewrite  items (sk REWRITE#...)  -> rewrite-rule.schema.json
 * Run: npm test -w shared
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv } from "ajv";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

const redirectSchema = readJson(join(root, "redirect-rule.schema.json"));
const rewriteSchema = readJson(join(root, "rewrite-rule.schema.json"));

// Strict-mode warnings are collected rather than printed: Ajv only logs them,
// so a schema that trips one still validates and the warning goes unnoticed —
// until it shows up in every API cold start.
const warnings: unknown[][] = [];
const ajv = new Ajv({
  allErrors: true,
  useDefaults: false,
  logger: {
    log: console.log,
    warn: (...args: unknown[]) => warnings.push(args),
    error: console.error,
  },
});
ajv.addSchema(redirectSchema, "redirect-rule.schema.json");
ajv.addSchema(rewriteSchema, "rewrite-rule.schema.json");

let failures = 0;
for (const file of readdirSync(join(root, "examples")).sort()) {
  if (!file.endsWith(".json")) continue;
  const item = readJson(join(root, "examples", file));
  const sk: string = item.sk ?? "";
  const schemaKey = sk.startsWith("REDIRECT#")
    ? "redirect-rule.schema.json"
    : sk.startsWith("REWRITE#")
      ? "rewrite-rule.schema.json"
      : null;

  if (!schemaKey) {
    console.error(
      `✗ ${file}: sk "${sk}" matches neither REDIRECT# nor REWRITE#`,
    );
    failures++;
    continue;
  }

  const validate = ajv.getSchema(schemaKey);
  if (!validate) throw new Error(`schema not registered: ${schemaKey}`);

  if (validate(item)) {
    console.log(`✓ ${file} valid against ${schemaKey}`);
  } else {
    console.error(`✗ ${file} INVALID against ${schemaKey}`);
    for (const err of validate.errors ?? []) {
      console.error(`    ${err.instancePath || "(root)"} ${err.message}`);
    }
    failures++;
  }
}

// Compiled lazily by getSchema above; compile both so neither escapes.
ajv.getSchema("redirect-rule.schema.json");
ajv.getSchema("rewrite-rule.schema.json");
for (const warning of warnings) {
  console.error(`✗ Ajv warning: ${warning.map(String).join(" ")}`);
  failures++;
}

if (failures > 0) {
  console.error(`\n${failures} problem(s): failed examples or Ajv warnings`);
  process.exit(1);
}
console.log("\nAll examples valid.");
