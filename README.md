# cloudfront-redirect-rules

> Pluggable, DynamoDB-backed redirect & rewrite rules for **any** CloudFront distribution — a Lambda@Edge you attach to your own distro. It never manages your distribution.

🚧 **Coming soon** — under active development (30-day MVP in progress).

## How it plugs in

The Terraform module in `infra/` creates a DynamoDB rules table and a Lambda@Edge (published version), and outputs two qualified ARNs. You attach them to **your own** distribution with two `lambda_function_association` blocks:

- **viewer-request** → redirects (301/302)
- **origin-request** → rewrites (rewrite the path and/or switch the request to a different origin)

That's the entire integration surface. The module takes no input about your distribution and never touches it.

## Repo layout

```
cloudfront-redirect-rules/
├── shared/                  # JSON Schemas — the rule contract (single source of truth)
│   ├── redirect-rule.schema.json   # erMatchRule
│   ├── rewrite-rule.schema.json    # frMatchRule
│   ├── examples/            # valid example items (with DynamoDB keys), validated in CI
│   ├── test/validate.ts     # ajv validation of examples ↔ schemas
│   └── README.md            # pk/sk, zero-padding, query & write semantics
├── infra/                   # THE PRODUCT (phase 1): Terraform module + Lambda@Edge (scaffold TBD)
├── console/                 # Step 2: management API + web UI (placeholders only)
│   ├── api/
│   └── ui/
├── .github/workflows/ci.yml # lint + typecheck + schema validation on PR / push to main
├── package.json             # npm workspaces root
└── tsconfig.base.json       # shared TS compiler options
```

| Path       | What it is                                                                                                                       |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `infra/`   | **The product (phase 1)**: pluggable Terraform module — DynamoDB table + Lambda@Edge                                             |
| `shared/`  | JSON Schemas for redirect (`erMatchRule`) / rewrite (`frMatchRule`) rules — the rule contract, plus DynamoDB key/query semantics |
| `console/` | **Step 2**: management API + web UI for the rules (placeholder for now)                                                          |

## Notes & constraints

- Runtime is **Lambda@Edge** (it can query DynamoDB). CloudFront Functions were evaluated and rejected: no network access.
- Lambda@Edge deploys in `us-east-1` regardless of your table region or distribution.
- Origin-request rewrites fire on cache misses — your cache policy affects observed behavior.
- Rule changes propagate in ~1 minute (edge cache TTL).

## Development

Requires **Node 20+**. This is an npm-workspaces monorepo; install once from the root.

```bash
npm ci            # install all workspaces
npm run lint      # eslint + prettier --check
npm run format    # prettier --write (fix formatting)
npm run typecheck # tsc --noEmit across workspaces (--if-present)
npm test          # runs each workspace's tests (--if-present)
```

To work on just one workspace, target it with `-w`:

```bash
npm test -w shared   # validate shared/examples against the schemas
```

These same three checks — **lint**, **typecheck**, and **schemas** (`npm test`) — run in
GitHub Actions (`.github/workflows/ci.yml`) on every pull request and on push to `main`.
Run them locally before opening a PR.
