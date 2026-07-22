# modules/edge — Lambda@Edge packaging + IAM (ER-103)

Packages, publishes, and grants read access to the [redirect/rewrite
handler](../../lambda), and hands back a qualified version ARN. It does **not**
create a CloudFront distribution — you attach the function to your own (see
[Consumer integration](#consumer-integration)). Demo distributions live in
[`examples/infra`](../../../examples/infra).

## What it creates

- **`edge-config.generated.ts`** rendered into the handler bundle — the table
  name/region/TTL, since Lambda@Edge has no env vars.
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

## Consumer integration

Attach the published version to your distribution's default cache behavior —
nothing else changes in the module:

```hcl
default_cache_behavior {
  # ...
  lambda_function_association {
    event_type   = "viewer-request"
    lambda_arn   = module.edge.viewer_request_lambda_arn
    include_body = false
  }

  lambda_function_association {
    event_type   = "origin-request"
    lambda_arn   = module.edge.origin_request_lambda_arn
    include_body = false
  }
}
```

## Inputs

| Name                | Type        | Default                    | Description                                        |
| ------------------- | ----------- | -------------------------- | -------------------------------------------------- |
| `table_name`        | string      | —                          | DynamoDB rules table name (baked into the bundle). |
| `table_arn`         | string      | —                          | Table ARN; scopes the read-only IAM policy.        |
| `table_region`      | string      | —                          | Table region (baked into the bundle).              |
| `function_name`     | string      | `edgeroute-redirect-rules` | Published function name.                           |
| `cache_ttl_ms`      | number      | `60000`                    | In-memory rule cache TTL, baked in.                |
| `lambda_source_dir` | string      | `../../lambda`             | Path to the handler workspace.                     |
| `monorepo_root`     | string      | `../../..`                 | Repo root where `npm ci` runs.                     |
| `tags`              | map(string) | `{}`                       | Tags for the function and role.                    |

## Outputs

| Name                        | Description                                             |
| --------------------------- | ------------------------------------------------------- |
| `lambda_qualified_arn`      | Published version ARN.                                  |
| `viewer_request_lambda_arn` | Same qualified ARN, for the viewer-request association. |
| `origin_request_lambda_arn` | Same qualified ARN, for the origin-request association. |
| `function_name`             | Published function name.                                |
| `role_arn`                  | Execution role ARN.                                     |

## Teardown note

CloudFront holds replicas of an edge function for ~15 min–1 hr after a
distribution stops referencing it, so a `destroy` that removes the function may
first fail with a replica error. Retry once replicas have cleared.
