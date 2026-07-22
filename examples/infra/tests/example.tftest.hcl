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
}
