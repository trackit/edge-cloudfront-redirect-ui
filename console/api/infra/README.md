# console API — infrastructure

Terraform for the control-plane API: an HTTP API Gateway (v2) fronting a single
Node 20 Lambda that runs the request router in `console/api/src`.

## What it creates

- **`aws_lambda_function`** — `nodejs20.x`, handler `index.handler`. Bundled by
  esbuild (`console/api/build.mjs`) at apply and zipped from `dist/`.
- **`aws_apigatewayv2_api` + integration + `$default` route + stage** — an HTTP
  API with a catch-all route; the Lambda's own router dispatches every path.
- **`aws_iam_role`** — execution role with CloudWatch Logs only.
- **`aws_cloudwatch_log_group`** — `/aws/lambda/<function_name>`.

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

- **DynamoDB access / targets registry** — ER-203. No table IAM or env vars
  until rule persistence exists.
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
the invoke permission, and the log group name.
