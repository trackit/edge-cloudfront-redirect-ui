# @cloudfront-redirect-rules/shared

The **single source of truth** for redirect/rewrite rule shapes. Both stacks consume these schemas:

- `infra/` — the Lambda@Edge reads items in exactly this shape from DynamoDB
- `console/api` — the API validates and writes items in exactly this shape; the OpenAPI spec `$ref`s these schemas for its request/response bodies (never redefine rule shapes inline)

These schemas model the exact DynamoDB **item** shape the edge reads, derived from the source project's `redirect-rule-types.ts` (`EdgeRedirectRule` / `ForwardRewriteRule` / `MatchCondition`). Not to be confused with the source project's hostname-keyed YAML _authoring-file_ schemas — that was the rejected snippet framework's format, a different layer.

**Rule shape notes**

- **Match conditions** use `matchType` / `matchOperator` / `matchValue` (+ optional `negate`, `caseSensitive`, `headerName`). `matchType ∈ {path, hostname, protocol, regex, header, cookie}`, `matchOperator ∈ {equals, contains, regex}`. `headerName` is required iff `matchType` is `header`.
- **`useRelativeUrl`** (redirect) is the enum `"relative_url" | "absolute_url"`, **not** a boolean.
- **`forwardSettings.origin`** (rewrite) is a discriminated union — exactly one of `s3` / `custom` — mirroring the CloudFront `request.origin` structure from `@types/aws-lambda` (the edge assigns it straight through). See both example items.
- **`disabled`** is optional and reserved for a future "toggle off" feature; the source runtime does **not** honor it yet, so ER-101 must skip `disabled: true` rules or it's a no-op.

## Files

| File                        | What                                                              |
| --------------------------- | ----------------------------------------------------------------- |
| `redirect-rule.schema.json` | Redirect item — `type: erMatchRule`, `sk` = `REDIRECT#<priority>` |
| `rewrite-rule.schema.json`  | Rewrite item — `type: frMatchRule`, `sk` = `REWRITE#<priority>`   |
| `examples/`                 | One complete valid DDB item per rule type — validated in CI       |
| `test/validate.ts`          | Validates every example against its schema (`npm test -w shared`) |

## Storage semantics (what JSON Schema can't express)

**Keys**

- `pk` (string) — the host, e.g. `www.example.com`
- `sk` (string) — `TYPE#priority` where `TYPE ∈ {REDIRECT, REWRITE}` and priority is a **zero-padded 5-digit integer** (e.g. `REDIRECT#00100`). Lower number = higher priority. Priority must be **unique per host per type** — the API enforces this (ER-204); the format itself is enforced by the `sk` `pattern` in each schema.

**Access patterns**

- The Lambda@Edge **reads**: `Query(pk = host, begins_with(sk, "REDIRECT#"))` on viewer-request, `begins_with(sk, "REWRITE#")` on origin-request. Results are cached in-memory briefly at the edge.
- The console API **writes**: Put / Update / Delete of whole items. It never talks to the Lambda@Edge — the table is the only interface.

**Propagation**

Edge cache TTL means a rule change takes effect in **~1 minute**. The UI must communicate this (ER-306 / editors).
