# Plan-only, mocked provider — hermetic (no AWS, no build). Asserts the wiring
# that matters: both L@E associations land on the distribution, and the origin
# selection responds to var.origin_domain_name.
mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{}" }
  }
}

mock_provider "aws" {
  alias = "use1"
}

# Replace the edge module with known outputs so it isn't built during the test
# and the association set has concrete (not unknown) values to assert on.
override_module {
  target = module.edge
  outputs = {
    lambda_qualified_arn      = "arn:aws:lambda:us-east-1:123456789012:function:edge:1"
    viewer_request_lambda_arn = "arn:aws:lambda:us-east-1:123456789012:function:edge:1"
    origin_request_lambda_arn = "arn:aws:lambda:us-east-1:123456789012:function:edge:1"
    function_name             = "edge"
    role_arn                  = "arn:aws:iam::123456789012:role/edge-edge"
    # The origin request policy is built from this, so an override that omits it
    # plans a policy that forwards nothing.
    viewer_host_header = "x-edgeroute-viewer-host"
  }
}

# =============================================================================
# Lambda@Edge associations (ER-103 #2)
# =============================================================================

run "both_associations_attached" {
  command = plan

  assert {
    condition     = length(aws_cloudfront_distribution.this.default_cache_behavior[0].lambda_function_association) == 2
    error_message = "distribution must attach exactly two Lambda@Edge associations"
  }

  assert {
    condition = length([
      for a in aws_cloudfront_distribution.this.default_cache_behavior[0].lambda_function_association :
      a if a.event_type == "viewer-request"
    ]) == 1
    error_message = "a viewer-request association is required (redirects)"
  }

  assert {
    condition = length([
      for a in aws_cloudfront_distribution.this.default_cache_behavior[0].lambda_function_association :
      a if a.event_type == "origin-request"
    ]) == 1
    error_message = "an origin-request association is required (rewrites)"
  }
}

# =============================================================================
# Origin selection (ER-103 #5)
# =============================================================================

run "placeholder_origin_by_default" {
  command = plan

  assert {
    condition     = length(aws_s3_bucket.origin) == 1
    error_message = "a placeholder S3 origin should be created when origin_domain_name is null"
  }
}

run "existing_origin_when_provided" {
  command = plan

  variables {
    origin_domain_name = "origin.example.com"
  }

  assert {
    condition     = length(aws_s3_bucket.origin) == 0
    error_message = "no placeholder bucket should be created when an existing origin is provided"
  }

  assert {
    condition     = aws_cloudfront_distribution.this.origin.*.domain_name == tolist(["origin.example.com"])
    error_message = "the distribution should use the provided origin domain"
  }

  assert {
    condition     = length(aws_s3_object.page) == 0
    error_message = "the demo pages belong to the placeholder bucket; there is nowhere to put them otherwise"
  }
}

# =============================================================================
# Forwarding the viewer-host header (the thing rewrites depend on)
# =============================================================================

run "viewer_host_header_is_forwarded_to_the_origin" {
  command = plan

  # CloudFront drops a header added at viewer-request unless a policy names it, so
  # without this every rewrite silently stops matching. Asserted on the policy
  # rather than on the behavior, because the behavior only carries the policy's
  # id and that is provider-computed.
  assert {
    condition = contains(
      aws_cloudfront_origin_request_policy.viewer_host.headers_config[0].headers[0].items,
      "x-edgeroute-viewer-host",
    )
    error_message = "the origin request policy must forward the viewer-host header, or no rewrite rule can match"
  }

  # Managed-AllViewer would also do it, and would also forward Host — which an S3
  # origin behind OAC rejects, since it has to receive the bucket's own hostname.
  assert {
    condition     = aws_cloudfront_origin_request_policy.viewer_host.headers_config[0].header_behavior == "whitelist"
    error_message = "forward the header by name; forwarding all viewer headers would send Host and break the OAC origin"
  }

  # A rewrite rule can match on the query string, so it has to survive too.
  assert {
    condition     = aws_cloudfront_origin_request_policy.viewer_host.query_strings_config[0].query_string_behavior == "all"
    error_message = "query strings must reach origin-request for query-string rule matching to work"
  }
}

# =============================================================================
# Demo pages on the placeholder origin
# =============================================================================

run "placeholder_origin_serves_more_than_one_page" {
  command = plan

  # A rewrite has to land somewhere visibly different from where the request
  # started, or nothing about it can be observed from outside.
  assert {
    condition     = length(setsubtract(["index.html", "pricing.html", "plans.html"], keys(aws_s3_object.page))) == 0
    error_message = "the placeholder origin must serve index.html plus at least two rewrite targets"
  }

  assert {
    condition     = alltrue([for o in values(aws_s3_object.page) : o.content_type == "text/html"])
    error_message = "each demo page must be served as text/html, or a browser will offer to download it"
  }
}

# =============================================================================
# Edge rule cache TTL
# =============================================================================

run "rejects_a_negative_cache_ttl" {
  command = plan

  variables {
    cache_ttl_ms = -1
  }

  expect_failures = [var.cache_ttl_ms]
}
