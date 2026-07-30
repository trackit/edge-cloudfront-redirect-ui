import { build } from "esbuild";

/**
 * Bundles the API handler for Lambda (ESM). Ajv and the shared JSON schemas are
 * inlined. The Terraform module runs this at apply and zips `dist/`.
 *
 * `@aws-sdk/*` stays external: the runtime provides it at
 * /var/runtime/node_modules/@aws-sdk/*, which is on the resolver path, so a bare
 * specifier resolves and we avoid shipping a second copy.
 *
 * `@smithy/*` is deliberately NOT external. The runtime keeps it nested at
 * .../@aws-sdk/node_modules/@smithy/*, reachable by the SDK but not from
 * /var/task — so marking it external would emit a bare specifier that fails at
 * import. It does not need to be bundled either: every @smithy package is
 * reached through an @aws-sdk one, which is external, so nothing pulls it in.
 * Bundling it is in fact not an option — it is CJS, and esbuild's ESM output
 * turns its internal `require("node:https")` into a call that throws at runtime.
 */
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
