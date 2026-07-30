import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";

/**
 * Packages the handler for Lambda@Edge. Terraform drives this at apply time
 * (ER-103), but it also runs standalone (`npm run build`) for local checks.
 *
 * Two outputs land in the output directory:
 *   - index.js            the bundled handler
 *   - edge-config.generated.js   the baked config, kept as a sibling file
 *
 * @aws-sdk/* is marked external: the nodejs20.x runtime already ships the v3
 * SDK, and bundling it would push the viewer-request package past its 1 MB
 * (compressed) limit. edge-config.generated.js is emitted separately because
 * the handler imports it through a variable specifier at runtime, so esbuild
 * leaves that import unresolved rather than inlining the config.
 *
 * EDGE_OUT_DIR / EDGE_GENERATED_CONFIG let Terraform point one module instance
 * at its own build tree — instantiating the module twice would otherwise race
 * two parallel builds over these shared paths. The defaults keep a bare
 * `npm run build` writing where it always has.
 */

// `||`, not `??`: an unset variable expands to "" in most CI runners, and an
// empty EDGE_OUT_DIR would resolve to the workspace root and overwrite
// package.json with the ESM marker written below.
const OUTDIR = resolve(process.env["EDGE_OUT_DIR"] || "dist");
const GENERATED = resolve(
  process.env["EDGE_GENERATED_CONFIG"] || "src/edge-config.generated.ts",
);

mkdirSync(OUTDIR, { recursive: true });

await build({
  entryPoints: ["src/index.ts"],
  outfile: `${OUTDIR}/index.js`,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  external: ["@aws-sdk/*"],
});

// Rendered by Terraform before packaging; absent for a bare local build, where
// the handler falls back to RULES_* env vars.
if (existsSync(GENERATED)) {
  await build({
    entryPoints: [GENERATED],
    outfile: `${OUTDIR}/edge-config.generated.js`,
    bundle: false,
    platform: "node",
    target: "node20",
    format: "esm",
  });
}

// Load index.js / edge-config.generated.js as ES modules inside the zip.
writeFileSync(
  `${OUTDIR}/package.json`,
  `${JSON.stringify({ type: "module" }, null, 2)}\n`,
);
