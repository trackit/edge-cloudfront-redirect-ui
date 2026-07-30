# console API — infrastructure

Terraform for the control-plane API: an HTTP API Gateway (v2) fronting a single
Node 20 Lambda that runs the request router in `console/api/src`.

## What it creates

- **`aws_lambda_function`** — `nodejs20.x`, handler `index.handler`. Bundled by
  esbuild (`console/api/build.mjs`) at apply and zipped from `dist/`.
- **`aws_apigatewayv2_api` + integration + `$default` route + stage** — an HTTP
  API with a catch-all route; the Lambda's own router dispatches every path.
- **`aws_iam_role`** — execution role: CloudWatch Logs, read/write on the
  targets registry table, and `sts:AssumeRole` on `assumable_role_arns` (see
  [Reaching a target's table](#reaching-a-targets-table)).
- **`aws_cloudwatch_log_group`** — `/aws/lambda/<function_name>`.
- **`aws_dynamodb_table` (targets registry)** — the control-plane's own state
  (`pk=id`, `PAY_PER_REQUEST`, PITR on, deletion protection on). Passed to the
  Lambda as `TARGETS_TABLE_NAME`. Separate from every rules table.

## Reaching a target's table

Targets are registered **at runtime**; IAM is granted **at apply time**. Those
two facts do not meet on their own: a DynamoDB ARN is
`arn:aws:dynamodb:<region>:<account>:table/<name>`, so a static policy has to
enumerate every table before it exists.

Three ways to bridge that, and this module takes the third:

|                                       | Self-service                      | Least-privilege                        | Cross-account  |
| ------------------------------------- | --------------------------------- | -------------------------------------- | -------------- |
| Enumerate table ARNs in a variable    | no — a Terraform apply per target | yes                                    | no             |
| Wildcard on a table-name prefix       | yes                               | no — any matching table in the account | no             |
| **Per-target `roleArn` + AssumeRole** | **yes**                           | **yes**                                | **yes, later** |

So a target carries an optional **`roleArn`**. The API assumes it to read and
write that target's rules table, and `assumable_role_arns` is what the execution
role is allowed to assume:

```hcl
module "console_api" {
  source        = "../console/api/infra"
  function_name = "edgeroute-console-api"

  # Narrow to your role-naming convention — wildcards are allowed.
  assumable_role_arns = ["arn:aws:iam::123456789012:role/edgeroute-target-*"]
}
```

Each target's role needs a trust policy admitting this Lambda's execution role,
and a permissions policy covering its own rules table. A target with no `roleArn`
falls back to the API's own credentials, which today reach no rules table — so
`assumable_role_arns` must be set before rule operations (ER-203) work at all.

Cross-account targets are out of scope for now (the scope doc defers them), but
this shape is what makes them possible without changing the `Target` record
later — which is why the field exists now rather than after ER-301 generates a
typed client from these schemas.

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

- **Rule CRUD against a target's table** — ER-203. The access _mechanism_ is in
  place (see [Reaching a target's table](#reaching-a-targets-table)); what is
  missing is the persistence code that uses it. Rule routes resolve their target
  and then 501.
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
the invoke permission, the log group name, and the registry table + its
`TARGETS_TABLE_NAME` wiring.
