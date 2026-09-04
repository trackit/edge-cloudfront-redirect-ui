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

resource "aws_cloudfront_origin_access_control" "origin" {
  count = local.use_placeholder_origin ? 1 : 0

  name                              = "${var.function_name}-oac"
  description                       = "OAC for the edgeroute example origin"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Grants the distribution (and only it) read access to the bucket. Depends on
# the distribution ARN — the distribution does not depend on this policy, so
# there is no cycle.
data "aws_iam_policy_document" "origin" {
  count = local.use_placeholder_origin ? 1 : 0

  statement {
    sid       = "AllowCloudFrontServicePrincipalReadOnly"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.origin[0].arn}/*"]

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

resource "aws_s3_bucket_policy" "origin" {
  count = local.use_placeholder_origin ? 1 : 0

  bucket = aws_s3_bucket.origin[0].id
  policy = data.aws_iam_policy_document.origin[0].json
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
# S3 origin behind OAC has to receive the bucket's own hostname. Query strings are
# forwarded because a rewrite can match on them.
resource "aws_cloudfront_origin_request_policy" "viewer_host" {
  name    = "${var.function_name}-viewer-host"
  comment = "Forwards the edge function's viewer-host header to origin-request"

  headers_config {
    header_behavior = "whitelist"

    headers {
      items = [module.edge.viewer_host_header]
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
  comment             = "edgeroute example (ER-104)"
  price_class         = var.price_class
  default_root_object = local.use_placeholder_origin ? "index.html" : null

  origin {
    origin_id                = local.origin_id
    domain_name              = local.origin_domain
    origin_access_control_id = local.use_placeholder_origin ? aws_cloudfront_origin_access_control.origin[0].id : null

    # Only for an existing (non-S3) origin; the S3 placeholder uses OAC instead.
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
