locals {
  api_source_dir = coalesce(var.api_source_dir, "${path.module}/..")
  # console/api is an npm workspace, so the install runs at the repo root.
  monorepo_root = coalesce(var.monorepo_root, "${path.module}/../../..")

  install_command = trimspace(var.npm_install_command)
  build_command   = "npm run build --workspace @cloudfront-redirect-rules/api"

  handler_hash = sha256(join("", [
    for f in fileset(local.api_source_dir, "src/**/*.ts") :
    filesha256("${local.api_source_dir}/${f}")
  ]))

  # esbuild inlines the shared rule schemas into the bundle, so a schema-only
  # edit must repackage even though nothing under src/ changed.
  shared_schema_hash = sha256(join("", [
    for f in fileset("${local.monorepo_root}/shared", "*.schema.json") :
    filesha256("${local.monorepo_root}/shared/${f}")
  ]))
}

# esbuild -> dist/. Runs at apply so a bare `terraform apply` produces the zip.
resource "null_resource" "build" {
  triggers = {
    handler      = local.handler_hash
    schemas      = local.shared_schema_hash
    build_script = filesha256("${local.api_source_dir}/build.mjs")
    package      = filesha256("${local.api_source_dir}/package.json")
    # try(): a consumer who skips the install (or uses another package manager)
    # may have no npm lockfile, and a missing file would fail the whole plan.
    lockfile = try(filesha256("${local.monorepo_root}/package-lock.json"), "")
    # esbuild reads tsconfig, so a compiler-option change must repackage too.
    tsconfig = filesha256("${local.api_source_dir}/tsconfig.json")
  }

  provisioner "local-exec" {
    working_dir = local.monorepo_root
    command = (
      local.install_command == ""
      ? local.build_command
      : "${local.install_command} && ${local.build_command}"
    )
  }
}

# depends_on defers this data read to apply, after the build has populated dist/.
data "archive_file" "lambda_zip" {
  type        = "zip"
  source_dir  = "${local.api_source_dir}/dist"
  output_path = "${path.module}/build/${var.function_name}.zip"

  depends_on = [null_resource.build]
}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "this" {
  name               = "${var.function_name}-exec"
  assume_role_policy = data.aws_iam_policy_document.assume.json
  tags               = var.tags
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/aws/lambda/${var.function_name}"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

data "aws_iam_policy_document" "logs" {
  statement {
    sid     = "Logs"
    actions = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
    resources = [
      aws_cloudwatch_log_group.this.arn,
      "${aws_cloudwatch_log_group.this.arn}:*",
    ]
  }
}

resource "aws_iam_role_policy" "logs" {
  name   = "${var.function_name}-logs"
  role   = aws_iam_role.this.id
  policy = data.aws_iam_policy_document.logs.json
}

resource "aws_lambda_function" "this" {
  function_name = var.function_name
  role          = aws_iam_role.this.arn
  handler       = "index.handler"
  runtime       = "nodejs20.x"

  filename         = data.archive_file.lambda_zip.output_path
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256

  timeout     = var.timeout
  memory_size = var.memory_size

  # No env vars needed yet; the targets registry + DynamoDB access arrive in
  # ER-203, Cognito auth in ER-205.

  depends_on = [aws_iam_role_policy.logs, aws_cloudwatch_log_group.this]

  tags = var.tags
}

# HTTP API (v2) with a $default catch-all — the Lambda's own router dispatches
# every path, so no per-route wiring here.
resource "aws_apigatewayv2_api" "this" {
  name          = var.function_name
  protocol_type = "HTTP"
  tags          = var.tags
}

resource "aws_apigatewayv2_integration" "this" {
  api_id                 = aws_apigatewayv2_api.this.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.this.invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.this.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.this.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.this.id
  name        = "$default"
  auto_deploy = true
  tags        = var.tags
}

resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.this.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.this.execution_arn}/*/*"
}
