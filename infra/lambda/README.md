# @cloudfront-redirect-rules/lambda

The Lambda@Edge data plane (ER-102). **One** function, associated twice on your distribution:

| Association    | Sort key prefix | Behavior                                                               |
| -------------- | --------------- | ---------------------------------------------------------------------- |
| viewer-request | `REDIRECT#`     | Returns a 301/302 response on match                                    |
| origin-request | `REWRITE#`      | Rewrites `uri`/`querystring` and/or switches `request.origin` on match |

It dispatches on `cf.config.eventType`, so both associations point at the same published version. Any other event type passes through untouched.

Extracted from `edge-platform-functions-cdn`'s `src/snippets/dynamodb-redirect/`, with the snippet registry, bindings, pipeline, and logger framework dropped — this is a plain handler.

## Rule evaluation

1. `Query(pk = <Host header>, begins_with(sk, "REDIRECT#" | "REWRITE#"))`.
2. Rules with `disabled: true` are dropped.
3. Remaining rules are evaluated in ascending sort-key order (`REDIRECT#00010` before `REDIRECT#00100`) — lower priority number wins.
4. The **first** rule whose `matches` **all** pass is applied; the rest are ignored.
5. No match → the request passes through unmodified.

A DynamoDB error is logged and the request passes through — rules never fail a request.

## Config

Lambda@Edge does not support environment variables, so config is **baked into the bundle**
at package time (the ER-102 decision in [`../README.md`](../README.md)): Terraform renders
`edge-config.generated.ts` into its own build directory and packages it into the zip —
see [modules/edge](../modules/edge/README.md#using-the-module-more-than-once). It is not
written into this workspace. [`src/edge-config.generated.example.ts`](src/edge-config.generated.example.ts)
records its shape; a local `src/edge-config.generated.ts` is gitignored and read only by
local runs.

Env vars override the baked values when set, which is how tests and local runs configure it.
**They do not resolve at the edge** — don't rely on them in production.

| Setting      | Env var (local/test) | Baked key     | Default  |
| ------------ | -------------------- | ------------- | -------- |
| Table name   | `RULES_TABLE_NAME`   | `tableName`   | required |
| Table region | `RULES_TABLE_REGION` | `tableRegion` | required |
| Cache TTL    | `RULES_CACHE_TTL_MS` | `cacheTtlMs`  | `60000`  |

The cache is per execution environment and keyed by `host:kind`, so a rule change takes up to
TTL + propagation to appear — the ~1 minute quoted in the root README.

## Development

```bash
npm test -w @cloudfront-redirect-rules/lambda        # vitest
npm run typecheck -w @cloudfront-redirect-rules/lambda
```
