import { build } from "esbuild";

// Bundles the API handler for Lambda (nodejs20.x, ESM). Ajv and the shared JSON
// schemas are inlined; the runtime-provided aws-sdk v3 stays external. The
// Terraform module runs this at apply and zips `dist/`.
await build({
  entryPoints: ["src/handler.ts"],
  outfile: "dist/index.mjs",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  external: ["@aws-sdk/*"],
  logLevel: "info",
});
