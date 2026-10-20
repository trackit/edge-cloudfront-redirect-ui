locals {
  # No origin_domain_name given → stand up a throwaway S3 bucket to serve as the
  # distribution's origin.
  use_placeholder_origin = var.origin_domain_name == null
  origin_id              = "edge-origin"
  origin_domain = local.use_placeholder_origin ? (
    aws_s3_bucket.origin[0].bucket_regional_domain_name
  ) : var.origin_domain_name

  # What the placeholder origin serves. `index.html` is where an unmatched request
  # lands; the other two exist so a rewrite has somewhere visibly different to send
  # one. With a single page on the origin, a path rewrite lands back on the page
  # you already had and proves nothing you can see — and repointing a rule from one
  # to the other is what shows a rule change taking effect.
  origin_pages = {
    "index.html"   = "<h1>Origin reached</h1><p>No redirect/rewrite rule matched this request.</p>"
    "pricing.html" = "<h1>Pricing</h1><p>This is <code>/pricing.html</code> on the origin.</p>"
    "plans.html"   = "<h1>Plans</h1><p>This is <code>/plans.html</code> on the origin.</p>"
  }
}

# --- Data plane -------------------------------------------------------------

module "table" {
  source = "../../infra/modules/table"

  table_name = var.table_name
  region     = var.region
  # An example must be destroyable in one command.
  deletion_protection = false
  tags                = var.tags
}

module "edge" {
  source    = "../../infra/modules/edge"
  providers = { aws.use1 = aws.use1 }

  function_name = var.function_name
  table_name    = module.table.table_name
  table_arn     = module.table.table_arn
  table_region  = module.table.table_region
  cache_ttl_ms  = var.cache_ttl_ms
  tags          = var.tags
}

# --- Placeholder S3 origin (default) ---------------------------------------

# trivy:ignore:AVD-AWS-0089 access logging is unnecessary for a throwaway demo origin
# trivy:ignore:AVD-AWS-0090 versioning is unnecessary for a throwaway demo origin
resource "aws_s3_bucket" "origin" {
  count = local.use_placeholder_origin ? 1 : 0

  bucket_prefix = "edgeroute-example-origin-"
  # Let `terraform destroy` remove the bucket even with the sample object in it.
  force_destroy = true
  tags          = var.tags
}

resource "aws_s3_bucket_public_access_block" "origin" {
  count = local.use_placeholder_origin ? 1 : 0

  bucket                  = aws_s3_bucket.origin[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_object" "page" {
  for_each = local.use_placeholder_origin ? local.origin_pages : {}

  bucket       = aws_s3_bucket.origin[0].id
  key          = each.key
  content      = "<!doctype html><title>edgeroute example origin</title>${each.value}"
  content_type = "text/html"
}

# An origin access identity rather than origin access control, which AWS now
# recommends, because a rewrite can switch origin and only an OAI survives that.
# OAC does not sign a request whose origin Lambda@Edge changed, and an S3 origin
# set by the edge with `authMethod: origin-access-identity` must use the same OAI
# as the origin it replaced ("authMethod" in the Lambda@Edge event structure
# reference). So both buckets below trust this one identity.
resource "aws_cloudfront_origin_access_identity" "origin" {
  count = local.use_placeholder_origin ? 1 : 0

  comment = "edgeroute example origins (${var.function_name})"
}

# Grants the identity (and only it) read access to a bucket. Without
# s3:ListBucket, a missing key answers 403 rather than 404.
data "aws_iam_policy_document" "origin" {
  for_each = local.use_placeholder_origin ? {
    origin     = aws_s3_bucket.origin[0].arn
    s3_rewrite = aws_s3_bucket.s3_rewrite[0].arn
  } : {}

  statement {
    sid       = "AllowCloudFrontOriginAccessIdentityReadOnly"
    actions   = ["s3:GetObject"]
    resources = ["${each.value}/*"]

    principals {
      type        = "AWS"
      identifiers = [aws_cloudfront_origin_access_identity.origin[0].iam_arn]
    }
  }
}

resource "aws_s3_bucket_policy" "origin" {
  count = local.use_placeholder_origin ? 1 : 0

  bucket = aws_s3_bucket.origin[0].id
  policy = data.aws_iam_policy_document.origin["origin"].json
}

# --- Origins a rewrite can switch to ---------------------------------------

# A second private bucket, so a rewrite with an S3 origin has somewhere else to
# send a request. Only with the placeholder origin: an OAI cannot be used when
# the request starts at a custom origin.
#
# trivy:ignore:AVD-AWS-0089 access logging is unnecessary for a throwaway demo origin
# trivy:ignore:AVD-AWS-0090 versioning is unnecessary for a throwaway demo origin
resource "aws_s3_bucket" "s3_rewrite" {
  count = local.use_placeholder_origin ? 1 : 0

  bucket_prefix = "edgeroute-example-s3-rewrite-"
  force_destroy = true
  tags          = var.tags
}

resource "aws_s3_bucket_public_access_block" "s3_rewrite" {
  count = local.use_placeholder_origin ? 1 : 0

  bucket                  = aws_s3_bucket.s3_rewrite[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# The same key the request asks for, so the rule only has to switch origin: on
# the distribution's own bucket this path does not exist.
resource "aws_s3_object" "s3_rewrite_page" {
  count = local.use_placeholder_origin ? 1 : 0

  bucket       = aws_s3_bucket.s3_rewrite[0].id
  key          = "s3-rewrite.html"
  content      = "<!doctype html><title>edgeroute example origin</title><h1>S3 rewrite</h1><p>Served from the second bucket, not the distribution's own origin.</p>"
  content_type = "text/html"
}

resource "aws_s3_bucket_policy" "s3_rewrite" {
  count = local.use_placeholder_origin ? 1 : 0

  bucket = aws_s3_bucket.s3_rewrite[0].id
  policy = data.aws_iam_policy_document.origin["s3_rewrite"].json
}

# A custom origin that answers with the request it received, as JSON. Switching
# to it is the custom-origin rewrite, and the echo shows what the edge sent: the
# path, the query string, and the headers, so the viewer-host header being
# removed and a dropped query string can be seen too.
data "archive_file" "echo" {
  type        = "zip"
  output_path = "${path.module}/.terraform/echo.zip"

  source {
    filename = "index.mjs"
    content  = <<-JS
      export const handler = async (event) => ({
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          {
            origin: "edgeroute example echo",
            method: event.requestContext.http.method,
            path: event.rawPath,
            query: event.rawQueryString,
            headers: event.headers,
          },
          null,
          2,
        ),
      });
    JS
  }
}

data "aws_iam_policy_document" "echo_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# No policy: the echo calls nothing, and its logs are not worth a grant.
resource "aws_iam_role" "echo" {
  name               = "${var.function_name}-echo"
  assume_role_policy = data.aws_iam_policy_document.echo_assume.json
  tags               = var.tags
}

# trivy:ignore:AVD-AWS-0066 tracing is unnecessary for a throwaway demo origin
resource "aws_lambda_function" "echo" {
  function_name    = "${var.function_name}-echo"
  role             = aws_iam_role.echo.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.echo.output_path
  source_code_hash = data.archive_file.echo.output_base64sha256
  tags             = var.tags
}

# Public on purpose: CloudFront calls a custom origin like any client, and the
# echo holds nothing.
resource "aws_lambda_function_url" "echo" {
  function_name      = aws_lambda_function.echo.function_name
  authorization_type = "NONE"
}

# A public function URL needs both grants since October 2025.
resource "aws_lambda_permission" "echo_url" {
  statement_id           = "AllowPublicFunctionUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.echo.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

resource "aws_lambda_permission" "echo_invoke" {
  statement_id             = "AllowPublicInvokeViaFunctionUrl"
  action                   = "lambda:InvokeFunction"
  function_name            = aws_lambda_function.echo.function_name
  principal                = "*"
  invoked_via_function_url = true
}

# --- Distribution -----------------------------------------------------------

# Redirects/rewrites must evaluate on every request, so caching is disabled.
data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}

# Without this, rewrites never match.
#
# The function stamps the viewer's hostname at viewer-request and reads it back at
# origin-request, because CloudFront has replaced `Host` with the origin's domain by
# then. But CloudFront builds the origin request from the cache key plus the origin
# request policy — with caching disabled and no policy, the stamped header is
# dropped in between, the lookup falls back to the origin's domain, and no rule is
# found. Confirmed the hard way on a real distribution: the function logged
# `no viewer host stamped at origin-request` with the bucket's domain as the key.
#
# A whitelist rather than Managed-AllViewer: that one forwards `Host` too, and an
# S3 origin behind an OAI has to receive the bucket's own hostname. Query strings are
# forwarded because a rewrite can match on them.
#
# `CloudFront-Viewer-Country` is for country conditions: it is how CloudFront is
# asked for the viewer's country at all. An origin request policy is enough here
# only because caching is disabled — a caching behavior needs it in the cache
# key instead.
resource "aws_cloudfront_origin_request_policy" "viewer_host" {
  name    = "${var.function_name}-viewer-host"
  comment = "Forwards the edge function's viewer-host header and the viewer's country to origin-request"

  headers_config {
    header_behavior = "whitelist"

    headers {
      items = [
        module.edge.viewer_host_header,
        "CloudFront-Viewer-Country",
      ]
    }
  }

  cookies_config {
    cookie_behavior = "none"
  }

  query_strings_config {
    query_string_behavior = "all"
  }
}

# trivy:ignore:AVD-AWS-0010 access logging is unnecessary for a throwaway demo distribution
# trivy:ignore:AVD-AWS-0011 WAF is out of scope for the example
resource "aws_cloudfront_distribution" "this" {
  enabled             = true
  comment             = "edgeroute example (CF-10)"
  price_class         = var.price_class
  default_root_object = local.use_placeholder_origin ? "index.html" : null

  origin {
    origin_id   = local.origin_id
    domain_name = local.origin_domain

    dynamic "s3_origin_config" {
      for_each = local.use_placeholder_origin ? [1] : []
      content {
        origin_access_identity = aws_cloudfront_origin_access_identity.origin[0].cloudfront_access_identity_path
      }
    }

    # Only for an existing (non-S3) origin; the S3 placeholder uses the OAI instead.
    dynamic "custom_origin_config" {
      for_each = local.use_placeholder_origin ? [] : [1]
      content {
        http_port              = 80
        https_port             = 443
        origin_protocol_policy = "https-only"
        origin_ssl_protocols   = ["TLSv1.2"]
      }
    }
  }

  default_cache_behavior {
    target_origin_id         = local.origin_id
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id = aws_cloudfront_origin_request_policy.viewer_host.id

    # One published function, associated twice — it dispatches on eventType.
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
