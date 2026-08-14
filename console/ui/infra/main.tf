locals {
  ui_source_dir = coalesce(var.ui_source_dir, "${path.module}/..")
  # console/ui is an npm workspace, so the install runs at the repo root.
  monorepo_root = coalesce(var.monorepo_root, "${path.module}/../../..")

  install_command = trimspace(var.npm_install_command)
  build_command   = "npm run build --workspace @cloudfront-redirect-rules/ui"

  # local-exec runs at monorepo_root, so a path relative to this module would not
  # resolve there.
  dist_dir = abspath("${local.ui_source_dir}/dist")

  # Everything the built SPA is made of. The build runs when any of it changes —
  # `src/**` rather than `src/**/*.ts` because the UI is .tsx and .css too, and
  # `src/api/schema.gen.ts` lives there, so an OpenAPI change is covered.
  source_hash = sha256(join("", [
    for f in setunion(
      fileset(local.ui_source_dir, "src/**"),
      fileset(local.ui_source_dir, "public/**"),
      ["index.html", "package.json", "vite.config.ts", "tsconfig.json", "tsconfig.node.json"],
    ) : filesha256("${local.ui_source_dir}/${f}")
  ]))

  # Only the host: the /api/* behavior forwards to the API's root, and the
  # function strips the prefix. Validated on the variable.
  api_origin_domain = regex("^https://([a-z0-9.-]+)/?$", var.api_endpoint)[0]

  s3_origin_id  = "console-ui"
  api_origin_id = "console-api"
}

# --- The bucket the SPA is served from -------------------------------------

# trivy:ignore:AVD-AWS-0089 access logging is unnecessary for a demo console
# trivy:ignore:AVD-AWS-0090 versioning is unnecessary — every object is rebuilt from source
resource "aws_s3_bucket" "ui" {
  bucket_prefix = "${var.name}-ui-"
  # The bucket holds build output and nothing else, so a destroy should not need
  # the objects emptied by hand first.
  force_destroy = true
  tags          = var.tags
}

resource "aws_s3_bucket_public_access_block" "ui" {
  bucket                  = aws_s3_bucket.ui.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_cloudfront_origin_access_control" "ui" {
  name                              = "${var.name}-ui"
  description                       = "OAC for the ${var.name} SPA bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Grants this distribution, and only it, read access to the objects. Depends on
# the distribution ARN; the distribution does not depend on the policy, so there
# is no cycle.
data "aws_iam_policy_document" "ui" {
  statement {
    sid       = "AllowCloudFrontServicePrincipalReadOnly"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.ui.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.this.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "ui" {
  bucket = aws_s3_bucket.ui.id
  policy = data.aws_iam_policy_document.ui.json
}

# --- Build and upload -------------------------------------------------------

# Build then sync, in one resource, triggered on the sources rather than on the
# build output.
#
# The obvious alternative — `aws_s3_object` with `for_each = fileset(dist)` — does
# not work here: `fileset` is evaluated during plan, and on a fresh clone `dist/`
# does not exist yet, so the plan would contain zero objects and the first apply
# would upload nothing at all, silently. `aws s3 sync` also sets each object's
# Content-Type from its extension, which a hand-written for_each would have to
# carry a MIME map for.
#
# The trade-off: object-level drift is invisible to Terraform. Something deleting
# a file straight out of the bucket is only repaired by the next source change, or
# by tainting this resource.
resource "null_resource" "publish" {
  triggers = {
    sources = local.source_hash
    bucket  = aws_s3_bucket.ui.id
    build   = local.build_command
    install = local.install_command
    # try(): a consumer who skips the install may have no lockfile, and a missing
    # file would fail the whole plan.
    lockfile = try(filesha256("${local.monorepo_root}/package-lock.json"), "")
  }

  provisioner "local-exec" {
    working_dir = local.monorepo_root
    command = join(" && ", compact([
      local.install_command == "" ? "" : local.install_command,
      local.build_command,
      # --delete so a renamed hashed asset does not accumulate forever.
      "aws s3 sync ${local.dist_dir} s3://${aws_s3_bucket.ui.id} --delete",
    ]))
  }
}

# --- The gate ---------------------------------------------------------------

# One function, attached to both behaviors: basic auth, the /api prefix strip,
# and the SPA fallback. See gate.js.tftpl for why it is one function.
resource "aws_cloudfront_function" "gate" {
  name    = "${var.name}-gate"
  runtime = "cloudfront-js-2.0"
  comment = "Basic auth, /api prefix strip, SPA fallback for ${var.name}"
  publish = true

  code = templatefile("${path.module}/gate.js.tftpl", {
    credential = base64encode("${var.basic_auth_username}:${var.basic_auth_password}")
  })
}

# --- Distribution -----------------------------------------------------------

# Nothing here is cached: the SPA so a redeploy is visible without an
# invalidation, and the API because its responses are per-request state.
data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}

# Forwards the viewer's headers, query string and cookies to the API, except
# Host — API Gateway requires its own hostname to route the request.
data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

# trivy:ignore:AVD-AWS-0010 access logging is unnecessary for a demo console
# trivy:ignore:AVD-AWS-0011 WAF is out of scope; the gate function is the control
resource "aws_cloudfront_distribution" "this" {
  enabled             = true
  comment             = "${var.name} — console SPA + API"
  price_class         = var.price_class
  default_root_object = "index.html"

  origin {
    origin_id                = local.s3_origin_id
    domain_name              = aws_s3_bucket.ui.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.ui.id
  }

  origin {
    origin_id   = local.api_origin_id
    domain_name = local.api_origin_domain

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  # The SPA.
  default_cache_behavior {
    target_origin_id       = local.s3_origin_id
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = data.aws_cloudfront_cache_policy.caching_disabled.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.gate.arn
    }
  }

  # The API, same origin as the SPA so the browser needs no CORS — which matters,
  # because the API sends no CORS headers at all.
  ordered_cache_behavior {
    path_pattern           = "/api/*"
    target_origin_id       = local.api_origin_id
    viewer_protocol_policy = "redirect-to-https"
    # Rules are written over POST/PUT/PATCH/DELETE; a read-only method set here
    # would turn every edit in the console into a 403 from CloudFront.
    allowed_methods          = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.gate.arn
    }
  }

  # No custom_error_response mapping 404 to index.html, which is the usual SPA
  # recipe: those are distribution-wide, so the API's own 404s — an unknown host
  # or rule — would come back as index.html with status 200, and the console would
  # report them as malformed JSON. The gate function does the SPA fallback per
  # request instead, which leaves the API's status codes alone.

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = var.tags
}
