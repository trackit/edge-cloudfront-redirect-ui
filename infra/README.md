# infra — pluggable data-plane (phase 1 product)

A Terraform module that gives any existing CloudFront distribution dynamic, DynamoDB-backed redirect/rewrite rules — without managing that distribution.

## Modules

- `modules/table/` — DynamoDB rules table (ER-101, done): `pk`/`sk`, PAY_PER_REQUEST, PITR, single region. See its README.

## Planned module contract (spec for ER-102..103 — table done)

**Inputs:** table name/prefix, table region, tags. Nothing about any CloudFront distribution.

**Creates:**

- DynamoDB table — `pk` (host) / `sk` (`TYPE#priority`), PAY_PER_REQUEST, PITR on
- Lambda@Edge function (Node.js/TypeScript), **published as a version** — Lambda@Edge requires a qualified version ARN, never `$LATEST`
- IAM execution role with DynamoDB read (Query/GetItem) scoped to the table ARN

**Outputs:** `viewer_request_lambda_arn` (qualified), `origin_request_lambda_arn` (qualified), `table_name`, `table_arn`.

**Consumer integration:** add two `lambda_function_association` blocks (viewer-request, origin-request) to your own `aws_cloudfront_distribution`. Nothing else.

## Constraints

- Lambda@Edge must deploy in `us-east-1` → the module needs a `us-east-1` provider alias.
- Lambda@Edge has no native env vars. **Config strategy (ER-102 decision): bake at build time.** Terraform owns the table, so at package time it renders `{ tableName, tableRegion }` into a generated config (e.g. `edge-config.generated.ts`) bundled into the Lambda zip and imported by the handler. A config change re-publishes a new L@E version (required anyway) which propagates to the edge — no runtime lookup. Rejected alternatives: env vars (unsupported on L@E); SSM/runtime fetch (per-cold-start latency + extra IAM for static config); CloudFront origin custom headers (origin-request only, and would require touching the consumer's distribution — violates the contract).
- The rewrite handler may switch `request.origin` to a different s3/custom origin at runtime — consumers don't need to declare extra origins.
- No `aws_cloudfront_distribution` resource may ever live in this module — demo distributions belong in `examples/` only.
