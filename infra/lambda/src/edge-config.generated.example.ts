/**
 * Shape of `edge-config.generated.ts`, which Terraform renders into the Lambda
 * zip at package time (ER-102). The generated file is gitignored; this example
 * is the committed record of its shape.
 *
 * Lambda@Edge does not support environment variables, so the table coordinates
 * are baked into the bundle and a config change re-publishes a new version.
 */
export const generated = {
  tableName: "example-redirect-rules",
  tableRegion: "us-east-1",
  cacheTtlMs: 60_000,
};
