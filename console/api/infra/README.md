# console API — infrastructure

Terraform for the control-plane API: an HTTP API Gateway (v2) fronting a single
Node 22 Lambda that runs the request router in `console/api/src`.

## What it creates

- **`aws_lambda_function`** — `nodejs22.x`, handler `index.handler`. Bundled by
  esbuild (`console/api/build.mjs`) at apply and zipped from `dist/`.
- **`aws_apigatewayv2_api` + integration + `$default` route + stage** — an HTTP
  API with a catch-all route; the Lambda's own router dispatches every path.
- **`aws_iam_role`** — execution role: CloudWatch Logs, read/write on the targets
  registry table, `dynamodb:DescribeTable` on every table in the account (see
  [Checking a table exists](#checking-a-table-exists)), and — both off by
  default — `sts:AssumeRole` on `assumable_role_arns` plus item-level DynamoDB
  access on `target_table_arns`
  (see [Reaching a target's table](#reaching-a-targets-table)).
- **`aws_cloudwatch_log_group`** — `/aws/lambda/<function_name>`.
- **`aws_dynamodb_table` (targets registry)** — the control-plane's own state
  (`pk=id`, `PAY_PER_REQUEST`, PITR on). Named `<function_name>-targets` unless
  `targets_table_name` overrides it, and passed to the Lambda as
  `TARGETS_TABLE_NAME`. Separate from every rules table. Deletion protection is on
  via `deletion_protection` (default `true`) — the table is the only record of
  which rules table each target points at, so turn it off deliberately or not
  at all.

## Reaching a target's table

Targets are registered **at runtime**; IAM is granted **at apply time**. Those
two facts do not meet on their own: a DynamoDB ARN is
`arn:aws:dynamodb:<region>:<account>:table/<name>`, so a static policy has to
enumerate every table before it exists.

Two variables bridge that, and both are empty by default — so out of the box no
target is reachable:

| Approach                                                   | Self-service                      | Least-privilege                        |
| ---------------------------------------------------------- | --------------------------------- | -------------------------------------- |
| Enumerate table ARNs — **`target_table_arns`**             | no — a Terraform apply per target | yes                                    |
| Wildcard on a table-name prefix — also `target_table_arns` | yes                               | no — any matching table in the account |
| Per-target `roleArn` — **`assumable_role_arns`**           | yes                               | yes                                    |

**`target_table_arns`** grants the API's own execution role access to the tables
you name. A target with no `roleArn` uses those credentials, so it is reachable
only if its table is listed:

```hcl
target_table_arns = ["arn:aws:dynamodb:us-east-1:123456789012:table/edgeroute-rules-*"]
```

**`assumable_role_arns`** is the self-service route. A target carries a `roleArn`
and the API assumes it to reach that target's table, so registering a new target
needs no Terraform change:

```hcl
assumable_role_arns = ["arn:aws:iam::123456789012:role/edgeroute-target-*"]
```

Each target's role needs a trust policy admitting this Lambda's execution role and
a permissions policy covering its own rules table. Mirror the actions the
execution role gets on `target_table_arns` — in particular
**`dynamodb:BatchWriteItem`**, which deleting a host needs and which
`dynamodb:DeleteItem` does not imply.

That permissions policy should also include **`dynamodb:DescribeTable`**, for the
reason in the next section — and on a resource pattern wide enough to cover a
name that was typed wrong, not just the one table that should exist.

Both variables are validated, and the rules are the same for each: the **account
must be literal**, and the role or table name must be literal apart from an
optional **trailing `*`**. `?` is rejected anywhere, because IAM treats it as a
single-character wildcard. `target_table_arns` additionally requires a non-empty
region, though the region may itself be `*`. So:

| ARN                                         |                                                       |
| ------------------------------------------- | ----------------------------------------------------- |
| `…:role/edgeroute-target-*`                 | accepted                                              |
| `…dynamodb:*:1234…:table/edgeroute-rules-*` | accepted — region wildcards are fine                  |
| `*`                                         | rejected                                              |
| `…iam::*:role/*`                            | rejected — account is not literal                     |
| `…:role/*`, `…:table/*`                     | rejected — that is every role or table in the account |
| `…:role/??????????`                         | rejected — `?` is a wildcard too                      |
| `…:role/edge-*-prod`                        | rejected — the `*` must be last                       |
| `…dynamodb::1234…:table/x`                  | rejected — empty region matches nothing               |

Leave both empty and no target is reachable, so rule operations (ER-203) will
fail. That is the default deliberately — neither grant should be implicit.

The reason `roleArn` exists now rather than later is the runtime-vs-apply-time gap
above, not cross-account support: the scope doc puts cross-account under "not in
the 30 days", and nothing here has been exercised against a second account. What
the field does buy is that adding it later, after ER-301 generates a typed client
from these `additionalProperties: false` schemas, would be a breaking change.

## Checking a table exists

Registering a target describes its table first, so a mistyped name is refused
with a 400 instead of being stored as a second entry that only fails on the first
rules request. DynamoDB table names are case-sensitive, so `Edgeroute-rules` is
not a duplicate of `edgeroute-rules` — nothing else catches it.

Only a table AWS positively reports as absent is refused. Any other failure means
the API could not determine anything, and the registration is **allowed**:
targets are registered at runtime while IAM is granted at apply time, so a target
that is unreachable at registration is normal and must not be blocked. Those
still surface later as a 502 `TARGET_UNREACHABLE`.

That is why the module grants `dynamodb:DescribeTable` on **every table in the
account** (`arn:<partition>:dynamodb:*:<account>:table/*`) rather than on
`target_table_arns`. IAM answers a denied call before DynamoDB can say whether
the table is there, so a grant scoped to the tables that are _supposed_ to exist
denies exactly the mistyped names the check exists to catch — each one arriving
as "cannot tell" and being allowed through. The check would be silently off.
It is read-only metadata, no item data and no mutation, and it is unconditional
because a fresh deployment has no `target_table_arns` yet.

The same logic applies to a target with a `roleArn`, whose table is described
under **that** role: if its policy names the table exactly, a typo reads as
`AccessDenied` and the check is inert for that target. Widen the resource pattern
there to get it back.

When the check cannot run, the Lambda logs
`console-api: could not verify table … — registering it unchecked`. A steady
stream of those in CloudWatch means the typo check is not doing anything.

## Region validation

A target's `region` is checked against a list. By default that is the API's
built-in list of commercial regions, which has two problems: it ages, so a
newly-launched region is rejected even though the user owns a table there; and it
includes opt-in regions the account may never have enabled, which are accepted
and then fail later.

Set **`allowed_regions`** to the regions this deployment can actually reach and
both go away — it is passed through as `ALLOWED_REGIONS` and replaces the
built-in list:

```hcl
allowed_regions = ["us-east-1", "eu-west-1"]
```

## Build coupling

`null_resource.build` runs the dependency install followed by `npm run build
--workspace @cloudfront-redirect-rules/api` from the repo root at apply; the
`archive_file` data source is deferred (`depends_on`) so it zips `dist/` only
after that build.

It repackages when any of these change: `src/**/*.ts`, `build.mjs`,
`package.json`, `tsconfig.json` (esbuild reads it), the root
`package-lock.json`, or the shared rule schemas (esbuild inlines them, so a
schema-only edit still changes the bundle).

**`npm_install_command`** (default `npm ci`) is the install step. `npm ci`
deletes and reinstalls `node_modules`, so applying from a repo you also work in
wipes your install. Set it to `npm install` to keep your working tree, or to
`""` to skip installing and build against whatever is already there:

```hcl
module "console_api" {
  source              = "../console/api/infra"
  function_name       = "edgeroute-console-api"
  npm_install_command = "npm install"
}
```

## Not here yet

- **Cross-account targets** — the `roleArn` shape supports it; nothing has been
  exercised against a second account.
- **Cognito authorizer** — ER-205. The API is deployed open for now.

## Usage

```hcl
module "console_api" {
  source = "../console/api/infra"

  function_name = "edgeroute-console-api"
  tags          = { team = "edge" }
}

output "api_endpoint" {
  value = module.console_api.api_endpoint
}
```

`terraform apply`, then `curl "$(terraform output -raw api_endpoint)/health"` →
`{"status":"ok"}`.

## Tests

`terraform test` runs a mocked, plan-only suite (`tests/api.tftest.hcl`) — no
npm, no AWS. It asserts the Lambda runtime/handler/sizing, the HTTP API shape,
the invoke permission, the log group name, the registry table (including deletion
protection) and its `TARGETS_TABLE_NAME` wiring, that both access grants are
off by default and scoped to exactly the ARNs given when set, that a `"*"`
`assumable_role_arns` is rejected, that the rules-table grant never includes
`DeleteTable`, and that `ALLOWED_REGIONS` is passed through when set and omitted
entirely when not.
