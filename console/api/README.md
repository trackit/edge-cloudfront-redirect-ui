# @cloudfront-redirect-rules/api

The control-plane console API (CF-11). A single Node 22 Lambda behind an HTTP
API Gateway (v2) that manages redirect/rewrite rules in DynamoDB. It is a client
of the rules table — it only ever writes rules the [Lambda@Edge](../../infra/lambda)
reads; the two never talk directly.

Spec-first: [`openapi.yaml`](openapi.yaml) is the contract, and every rule
request/response body `$ref`s the schemas in [`../../shared`](../../shared) — rule
shapes are never redefined here.

## Routes

| Method               | Path                                          | Status                       |
| -------------------- | --------------------------------------------- | ---------------------------- |
| `GET`                | `/health`                                     | ✅ implemented               |
| `GET` / `POST`       | `/targets`                                    | ✅ implemented (CF-12)       |
| `GET`/`PUT`/`DELETE` | `/targets/{id}`                               | ✅ implemented (CF-12)       |
| `GET` / `POST`       | `/targets/{targetId}/hosts/{host}/rules`      | ✅ implemented (CF-13)       |
| `GET`/`PUT`/`DELETE` | `/targets/{targetId}/hosts/{host}/rules/{sk}` | ✅ implemented (CF-13)       |
| `PATCH`              | `/targets/{targetId}/hosts/{host}/rules/{sk}` | ✅ `disabled` toggle (CF-13) |

Rule routes are scoped to a **target** (a DynamoDB table from the targets
registry, CF-12) and a **host** (the partition key), and write to that target's
table.

The server owns both keys. A request body carries the rule's fields plus a
`priority` integer; `pk` is the host from the path and `sk` is
`TYPE#priority`, zero-padded to five digits (`REDIRECT#00100`). Responses are the
stored item — the exact shape the Lambda@Edge reads. Because the priority is part
of the key, a `PUT` that changes it **moves** the rule: one transaction writes the
new key and removes the old, so the rule is never live at two priorities.

`PATCH` is the exception to full-replace semantics: it takes `{ "disabled": … }`
and nothing else, so turning a rule off never depends on the client holding a
complete copy of it. A disabled rule keeps its place in the table and its
priority; the Lambda@Edge skips it. Like every rule change, it reaches the edge
within the edge cache TTL (~1 min), not instantly.

## Design

- **Router** (`src/router.ts`) — a hand-rolled method+path matcher with
  `:param` extraction. No web framework; one plain Lambda.
- **One request path** — `src/handler.ts` (Lambda) and `src/local.ts` (dev
  server) both build the same `ApiRequest` and run the same router.
- **Errors** (`src/lib/errors.ts`) — every failure is an `ApiError` serialized to
  a standard envelope: `{ "error": { "code", "message", "details"? } }`. `code`
  is a stable string the SPA switches on.
- **Validation** (`src/lib/validate.ts`) — Ajv compiled against the shared
  schemas; failures become `400 VALIDATION_ERROR` with per-field `details`.

## Develop

```bash
npm run dev -w console/api          # local HTTP server on :3000 (PORT to override)
curl localhost:3000/health          # {"status":"ok"}
```

## Test / lint / build

```bash
npm test -w console/api             # vitest (router, handler, validation)
npm run typecheck -w console/api    # tsc --noEmit
npm run openapi:lint -w console/api # redocly lint openapi.yaml
npm run build -w console/api        # esbuild -> dist/index.mjs
```

All four run in CI.

## Deploy

Terraform lives in [`infra/`](infra) — HTTP API Gateway + Lambda + IAM + logs.
See its [README](infra/README.md), and `cognito.tf` beside it for auth (CF-23):
a Cognito user pool, and a JWT authorizer that refuses a request at the gateway
before it reaches the Lambda. Four routes stay public — `/health`, and the three
`/auth` routes that issue the token in the first place.
