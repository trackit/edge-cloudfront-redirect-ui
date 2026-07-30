# modules/edge — Lambda@Edge packaging + IAM (ER-103)

Packages, publishes, and grants read access to the [redirect/rewrite
handler](../../lambda), and hands back a qualified version ARN. It does **not**
create a CloudFront distribution — you attach the function to your own (see
[Consumer integration](#consumer-integration)). Demo distributions live in
[`examples/infra`](../../../examples/infra).

## What it creates

- **`edge-config.generated.ts`** rendered into the handler bundle — the table
  name/region/TTL, since Lambda@Edge has no env vars. It is written to this
  instance's [build directory](#using-the-module-more-than-once), not into the
  handler workspace.
- **A packaged, published Lambda@Edge function** (`nodejs20.x`, `publish = true`)
  built with esbuild at apply time. The AWS SDK is left external (runtime-provided)
  so the viewer-request bundle stays under its 1 MB limit.
- **An IAM execution role** trusting `lambda` + `edgelambda`, granting
  `dynamodb:Query` scoped to the table ARN plus scoped CloudWatch Logs.

## One function, two associations

The handler dispatches on `cf.config.eventType`, so a single published version
serves both events. `viewer_request_lambda_arn` and `origin_request_lambda_arn`
are the **same** qualified ARN.

## Requirements

- Lambda@Edge must live in **us-east-1** — pass a us-east-1 provider as `aws.use1`.
- Node.js + npm on the machine running `terraform apply` — the build runs
  `npm ci && npm run build` at the repo root (the handler is an npm workspace).
  See [Using the module more than once](#using-the-module-more-than-once) if you
  instantiate the module twice in one config.

## Usage

```hcl
provider "aws" {
  alias  = "use1"
  region = "us-east-1"
}

module "table" {
  source     = "../../infra/modules/table"
  table_name = "edgeroute-redirect-rules"
}

module "edge" {
  source    = "../../infra/modules/edge"
  providers = { aws.use1 = aws.use1 }

  function_name = "edgeroute-redirect-rules"
  table_name    = module.table.table_name
  table_arn     = module.table.table_arn
  table_region  = module.table.table_region
}
```

## Wiring it into an existing distribution

The module never manages a distribution — you attach its published version to
one you already own. Three steps:

**1. Give the module a us-east-1 provider** (Lambda@Edge is us-east-1-only):

```hcl
provider "aws" {
  alias  = "use1"
  region = "us-east-1"
}
```

**2. Call the module** (see [Usage](#usage) above) so it packages, publishes,
and exposes the qualified ARN.

**3. Add the two associations to your distribution's cache behavior.** Both point
at the same qualified ARN — the handler dispatches on event type:

```hcl
resource "aws_cloudfront_distribution" "existing" {
  # ...your existing origins, behaviors, and certs — unchanged...

  default_cache_behavior {
    # ...your existing settings...

    lambda_function_association {
      event_type   = "viewer-request" # redirects (301/302)
      lambda_arn   = module.edge.viewer_request_lambda_arn
      include_body = false
    }

    lambda_function_association {
      event_type   = "origin-request" # rewrites (path / origin)
      lambda_arn   = module.edge.origin_request_lambda_arn
      include_body = false
    }
  }
}
```

`terraform apply` attaches them and CloudFront redeploys the distribution
(~5–15 min). Notes:

- Put the associations only on the **cache behaviors you want rules to run on** —
  add the same block to any `ordered_cache_behavior` that needs them.
- The ARNs are **qualified version ARNs** (required by CloudFront) — always take
  them from the module outputs; never hand-build them.
- Rules key on the request's `Host` header, so they apply to whatever hostname
  the viewer used (your distribution's domain or its alternate CNAMEs).

## Using the module more than once

Each instance builds in its own directory — `.build/<function_name>/` inside the
module by default, overridable with `build_dir` — so two instances in the same
config render their baked config and their bundle to separate paths. The handler
workspace (`infra/lambda`) is only ever read from. If you override `build_dir`,
give every instance a different one.

One shared resource is left: `npm ci` deletes and repopulates `node_modules` at
the repo root. Two instances applying in parallel will collide there, and the
usual symptom is the losing instance failing its **build** with
`Cannot find module 'esbuild'` — the install having been wiped under it. With
more than one instance, install once yourself and skip it in the module:

```hcl
module "edge_eu" {
  source    = "../../infra/modules/edge"
  providers = { aws.use1 = aws.use1 }

  function_name       = "edgeroute-eu"
  table_name          = module.table_eu.table_name
  table_arn           = module.table_eu.table_arn
  table_region        = module.table_eu.table_region
  npm_install_command = "" # run `npm ci` once before `terraform apply`
}
```

`terraform apply -parallelism=1` also works, at the cost of serialising the whole
apply.

If you applied an earlier version of this module, the next apply moves the
generated config out of `infra/lambda/src/` for you — no cleanup needed. Any copy
you keep there is yours alone, for [local runs](../../lambda/README.md#config);
the module neither reads it nor packages it.

## Inputs

| Name                  | Type        | Default                    | Description                                        |
| --------------------- | ----------- | -------------------------- | -------------------------------------------------- |
| `table_name`          | string      | —                          | DynamoDB rules table name (baked into the bundle). |
| `table_arn`           | string      | —                          | Table ARN; scopes the read-only IAM policy.        |
| `table_region`        | string      | —                          | Table region (baked into the bundle).              |
| `function_name`       | string      | `edgeroute-redirect-rules` | Published function name.                           |
| `cache_ttl_ms`        | number      | `60000`                    | In-memory rule cache TTL, baked in.                |
| `lambda_source_dir`   | string      | `../../lambda`             | Path to the handler workspace.                     |
| `monorepo_root`       | string      | `../../..`                 | Repo root where the install runs.                  |
| `build_dir`           | string      | `.build/<function_name>`   | This instance's build directory.                   |
| `npm_install_command` | string      | `npm ci`                   | Install run before the build; `""` skips it.       |
| `tags`                | map(string) | `{}`                       | Tags for the function and role.                    |

## Outputs

| Name                        | Description                                             |
| --------------------------- | ------------------------------------------------------- |
| `lambda_qualified_arn`      | Published version ARN.                                  |
| `viewer_request_lambda_arn` | Same qualified ARN, for the viewer-request association. |
| `origin_request_lambda_arn` | Same qualified ARN, for the origin-request association. |
| `function_name`             | Published function name.                                |
| `role_arn`                  | Execution role ARN.                                     |

## Updating & teardown

The function has `create_before_destroy = true`, so a change that replaces it
(e.g. a rename) won't fail mid-apply on the replica lock.

Teardown is the one case no lifecycle rule can smooth: CloudFront holds replicas
of an edge function for ~15 min–1 hr after a distribution stops referencing it,
so a `destroy` that removes the function may first fail with a replica error.
Retry once replicas have cleared.
