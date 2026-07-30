locals {
  lambda_source_dir = coalesce(var.lambda_source_dir, "${path.module}/../../lambda")
  # infra/lambda is an npm workspace, so `npm ci` runs at the repo root.
  monorepo_root = coalesce(var.monorepo_root, "${path.module}/../../..")

  # Everything this instance writes lives under a directory keyed on the
  # function name. The handler workspace itself stays read-only: two instances
  # applying in parallel would otherwise render their config over the same
  # src/ file and build into the same dist/, and each would zip whichever
  # bundle landed last.
  build_dir  = coalesce(var.build_dir, "${path.module}/.build/${var.function_name}")
  config_src = "${local.build_dir}/config/edge-config.generated.ts"
  dist_dir   = "${local.build_dir}/dist"

  install_command = trimspace(var.npm_install_command)
  build_command   = "npm run build --workspace @cloudfront-redirect-rules/lambda"

  # Baked config — Lambda@Edge has no env vars, so table coordinates ship in the
  # bundle. Matches src/edge-config.generated.example.ts.
  generated_config = <<-EOT
    export const generated = {
      tableName: "${var.table_name}",
      tableRegion: "${var.table_region}",
      cacheTtlMs: ${var.cache_ttl_ms},
    };
  EOT

  # Handler sources, minus the generated config (tracked separately below) so a
  # config-only change and a code change each rebuild. This module no longer
  # writes into src/, but the exclusion still matters: a developer may keep a
  # local src/edge-config.generated.ts for local runs (see ../../lambda/README.md),
  # and without it that gitignored file would make the hash machine-specific and
  # republish a version on every local edit.
  handler_hash = sha256(join("", [
    for f in fileset(local.lambda_source_dir, "src/**/*.ts") :
    filesha256("${local.lambda_source_dir}/${f}")
    if f != "src/edge-config.generated.ts"
  ]))
}

# Terraform owns the table, so it renders the baked config the handler imports.
# It sits outside the workspace because it's per-instance; esbuild packages it
# standalone (bundle = false) and it imports nothing, so location is irrelevant.
resource "local_file" "generated_config" {
  filename = local.config_src
  content  = local.generated_config
}

# esbuild → dist/. Runs at apply so a bare `terraform apply` produces the zip.
resource "null_resource" "build" {
  triggers = {
    config       = local_file.generated_config.content
    handler      = local.handler_hash
    build_script = filesha256("${local.lambda_source_dir}/build.mjs")
    package      = filesha256("${local.lambda_source_dir}/package.json")
    # try(): the lockfile is only guaranteed to exist for the default `npm ci`.
    # A consumer who skips the install (or uses another package manager) may not
    # have one, and a missing file would otherwise fail the whole plan.
    lockfile = try(filesha256("${local.monorepo_root}/package-lock.json"), "")
  }

  provisioner "local-exec" {
    working_dir = local.monorepo_root
    command = (
      local.install_command == ""
      ? local.build_command
      : "${local.install_command} && ${local.build_command}"
    )

    # npm runs a workspace script with its cwd set to the workspace, not to
    # working_dir, so the build script needs absolute paths.
    environment = {
      EDGE_OUT_DIR          = abspath(local.dist_dir)
      EDGE_GENERATED_CONFIG = abspath(local.config_src)
    }
  }

  depends_on = [local_file.generated_config]
}

# depends_on defers this data read to apply, after the build has populated dist/.
data "archive_file" "lambda_zip" {
  type        = "zip"
  source_dir  = local.dist_dir
  output_path = "${local.build_dir}/lambda.zip"

  depends_on = [null_resource.build]
}

data "aws_caller_identity" "current" {
  provider = aws.use1
}

# Both lambda.amazonaws.com and edgelambda.amazonaws.com — the second is what
# lets CloudFront replicate the function to the edge.
data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com", "edgelambda.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "permissions" {
  # The edge only ever runs Query (pk = host AND begins_with(sk, prefix)).
  statement {
    sid       = "ReadRules"
    actions   = ["dynamodb:Query"]
    resources = [var.table_arn]
  }

  # L@E logs land in region-local groups named /aws/lambda/<region>.<function>.
  statement {
    sid     = "Logs"
    actions = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
    resources = [
      "arn:aws:logs:*:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/*.${var.function_name}",
      "arn:aws:logs:*:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/*.${var.function_name}:*",
    ]
  }
}

resource "aws_iam_role" "this" {
  provider           = aws.use1
  name               = "${var.function_name}-edge"
  assume_role_policy = data.aws_iam_policy_document.assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy" "this" {
  provider = aws.use1
  name     = "${var.function_name}-read-rules"
  role     = aws_iam_role.this.id
  policy   = data.aws_iam_policy_document.permissions.json
}

resource "aws_lambda_function" "this" {
  provider = aws.use1

  function_name = var.function_name
  role          = aws_iam_role.this.arn
  handler       = "index.handler"
  runtime       = "nodejs20.x"

  filename         = data.archive_file.lambda_zip.output_path
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256

  # Lambda@Edge caps: viewer-request allows 5s / 128 MB. No env vars permitted —
  # config is baked into the bundle instead.
  timeout     = 5
  memory_size = 128

  # Qualified version ARN is required for the CloudFront association.
  publish = true

  # If a change ever forces this function to be replaced (e.g. a rename), the old
  # one can't be deleted while it's still replicated to CloudFront edges. Create
  # the replacement first so an update against a live distribution doesn't error
  # on the replica lock. (Full teardown still waits for replicas to age out —
  # that's an AWS-side delay no lifecycle rule can skip.)
  lifecycle {
    create_before_destroy = true
  }

  tags = var.tags
}
