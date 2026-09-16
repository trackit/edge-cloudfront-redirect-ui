# cloudfront-redirect-rules

> Pluggable, DynamoDB-backed redirect & rewrite rules for **any** CloudFront distribution — a Lambda@Edge you attach to your own distro. It never manages your distribution.

Two halves, both working:

- **The data plane** (`infra/`) — the product. A Terraform module that creates the rules table and the Lambda@Edge, and outputs the ARNs you attach to your distribution.
- **The control plane** (`console/`) — a management API and a web console for editing the rules: Cognito sign-in with viewer/editor roles, a registry of rule tables, hosts, and redirect/rewrite rules with an enable/disable toggle.

Neither half is required by the other. Rules are ordinary DynamoDB items described by the schemas in `shared/`, so the data plane runs perfectly well against a table you write to yourself.

## How it plugs in

The Terraform module in `infra/` creates a DynamoDB rules table and a Lambda@Edge (published version), and outputs two qualified ARNs. You attach them to **your own** distribution with two `lambda_function_association` blocks:

- **viewer-request** → redirects (301/302)
- **origin-request** → rewrites (rewrite the path and/or switch the request to a different origin)

The module takes no input about your distribution and never touches it. What it does ask of your distribution is small, but it is not nothing:

1. **Both associations**, as above. Rules are keyed on the hostname the viewer asked for, and CloudFront has replaced the `Host` header with the origin's domain by the time origin-request runs — so viewer-request is what carries that hostname across, in `X-EdgeRoute-Viewer-Host`. Redirects work either way; rewrites without viewer-request are looked up under the origin's domain, and on a distribution that forwards viewer headers, under whatever hostname the client chose to send. Attaching both is therefore a security requirement, not only a functional one.
2. **Forward that header to the origin**, in an origin request policy on each behavior the associations run on. CloudFront drops a header no policy names, even one added at viewer-request moments earlier — and then no rewrite rule ever matches. The header name is the module's `viewer_host_header` output.

Redirects need only the first. Rewrites need both, and both failures are silent from outside: the request simply reaches your origin unchanged. The function logs a warning when it reaches origin-request with no hostname, which is the fastest way to tell the two apart. See [modules/edge](infra/modules/edge/README.md#wiring-it-into-an-existing-distribution) for the policy, and [infra/lambda](infra/lambda/README.md#the-host-a-rule-is-keyed-on) for why any of this is necessary.

## Repo layout

```
cloudfront-redirect-rules/
├── shared/                          # JSON Schemas — the rule contract (single source of truth)
│   ├── redirect-rule.schema.json    # erMatchRule
│   ├── rewrite-rule.schema.json     # frMatchRule
│   ├── examples/                    # valid example items (with DynamoDB keys), validated in CI
│   └── test/validate.ts             # ajv validation of examples ↔ schemas
├── infra/                           # the data plane
│   ├── modules/table/               # DynamoDB rules table
│   ├── modules/edge/                # Lambda@Edge (published version) + IAM
│   └── lambda/                      # the function itself — TypeScript, bundled by build.mjs
├── console/                         # the control plane
│   ├── api/                         # Lambda + API Gateway; openapi.yaml is the published contract
│   └── ui/                          # React SPA (Vite), with vitest and Playwright suites
├── examples/infra/                  # a complete example deployment, plus seed-demo.sh
├── deploy/                          # per-environment tfvars and the CI deployment story
├── DEPLOY.md                        # deploying the whole thing to a sandbox by hand
├── .github/workflows/               # ci.yml + deploy-dev.yml
├── package.json                     # npm workspaces root
└── tsconfig.base.json               # shared TS compiler options
```

| Path       | What it is                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------ |
| `infra/`   | **The data plane**: pluggable Terraform module — DynamoDB table + Lambda@Edge                          |
| `shared/`  | JSON Schemas for redirect (`erMatchRule`) / rewrite (`frMatchRule`) rules, plus DynamoDB key semantics |
| `console/` | **The control plane**: management API + web console for the rules                                      |
| `deploy/`  | What CI needs to deploy an environment, and what has to exist before its first run                     |

Each directory has its own README with the detail: [shared](shared/README.md), [infra](infra/README.md), [infra/lambda](infra/lambda/README.md), [console](console/README.md), [console/api](console/api/README.md), [deploy](deploy/README.md).

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
npm test -w shared                        # validate shared/examples against the schemas
npm run dev -w console/api                # the API on localhost, against a real table
npm run dev -w console/ui                 # the console, proxying /api to the above
npm run test:e2e -w console/ui            # Playwright, with the API stubbed in the page
npm run openapi:lint -w console/api       # redocly lint
npm run generate:api -w console/ui        # regenerate the client types from openapi.yaml
```

`console/ui/src/api/schema.gen.ts` is generated from `console/api/openapi.yaml`. Edit the spec, never the generated file — CI fails if the two disagree (`generate:api:check`).

### What CI runs

`.github/workflows/ci.yml`, on every pull request and on push to `main`:

| Job                                   | What it does                                                         |
| ------------------------------------- | -------------------------------------------------------------------- |
| Lint (eslint + prettier)              | `npm run lint`                                                       |
| Typecheck (tsc --noEmit) + API bundle | `npm run typecheck`, `generate:api:check`, and the API bundle builds |
| Validate shared schemas + OpenAPI     | `npm test` across workspaces, then `redocly lint`                    |
| Console E2E (Playwright)              | `npm run test:e2e -w console/ui`, report uploaded as an artifact     |
| Terraform (fmt + validate + test)     | `fmt -check` over every stack, then `validate` + `test` per module   |

Run at least lint, typecheck and `npm test` locally before opening a PR.

Separately, `.github/workflows/deploy-dev.yml` deploys the sandbox dev environment on every push to `dev` (and on demand), after re-running the checks. See [deploy/README.md](deploy/README.md).

### Code comments

The comments here carry the _why_ — a constraint that is not visible from the code, a decision that looks arbitrary until you know what it rules out. That is worth keeping. What is not worth keeping is length: a reviewer reading a diff should not have to read around the prose to find the change.

So, roughly:

- **Inline** (`//`, a few lines): the non-obvious reason for _this_ line or block. If it runs past ~5 lines, it is explaining the module, not the line.
- **Module or function docblock** (`/** … */`): what the unit is for, and the decisions that shape the whole of it. One paragraph, ideally.
- **A README**: anything a reader needs _before_ opening the file — storage semantics, wiring requirements, the shape of a contract. Long-form belongs here, where it can be read in order.

Two things not to write: a comment restating what the next line plainly does, and the history of how the code got this way — that is what `git log` and the PR are for. When a comment and the code disagree, the comment is the bug.
