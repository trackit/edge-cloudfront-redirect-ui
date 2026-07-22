import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

/**
 * Packages the handler for Lambda@Edge. Terraform drives this at apply time
 * (ER-103), but it also runs standalone (`npm run build`) for local checks.
 *
 * Two outputs land in dist/:
 *   - index.js            the bundled handler
 *   - edge-config.generated.js   the baked config, kept as a sibling file
 *
 * @aws-sdk/* is marked external: the nodejs20.x runtime already ships the v3
 * SDK, and bundling it would push the viewer-request package past its 1 MB
 * (compressed) limit. edge-config.generated.js is emitted separately because
 * the handler imports it through a variable specifier at runtime, so esbuild
 * leaves that import unresolved rather than inlining the config.
 */

const OUTDIR = "dist";
const GENERATED = "src/edge-config.generated.ts";

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
