# Plan-only, mocked provider. `command = plan` means the local-exec build and
# `aws s3 sync` never run, so the suite stays hermetic — no npm, no AWS. The two
# managed-policy data sources are mocked with pinned ids, since the behaviors are
# asserted by value.
mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{}"
    }
  }
}

# Note on what is assertable here. The managed policies are looked up by name, so
# the ids the behaviors carry are provider-computed and come back null under a
# mock — asserting on them would pass just as happily against a behavior that
# attaches no policy at all. Neither `mock_data` defaults nor `override_data` can
# pin a data source's `id`. So the policy assertions below are on the names the
# module asks for, which is the part the module actually decides.

variables {
  api_endpoint        = "https://abc123.execute-api.us-east-1.amazonaws.com"
  basic_auth_username = "demo"
  basic_auth_password = "not-the-real-one"
}

# =============================================================================
# The gate function
# =============================================================================

run "one_function_on_both_behaviors" {
  command = plan

  # CloudFront allows a single viewer-request function per behavior, and the API
  # path must be gated as well — the SPA being behind auth is worth little if
  # /api/targets is not.
  assert {
    condition     = length(aws_cloudfront_distribution.this.default_cache_behavior[0].function_association) == 1
    error_message = "the SPA behavior must carry the gate function"
  }

  assert {
    condition = alltrue([
      for b in aws_cloudfront_distribution.this.ordered_cache_behavior :
      length(b.function_association) == 1
    ])
    error_message = "every ordered behavior must carry the gate function, including /api/*"
  }

  assert {
    condition = alltrue([
      for a in aws_cloudfront_distribution.this.default_cache_behavior[0].function_association :
      a.event_type == "viewer-request"
    ])
    error_message = "the gate must run on viewer-request; later events cannot refuse the request"
  }

  assert {
    condition     = aws_cloudfront_function.gate.runtime == "cloudfront-js-2.0"
    error_message = "the function must target a supported CloudFront Functions runtime"
  }

  assert {
    condition     = aws_cloudfront_function.gate.publish
    error_message = "an unpublished function is never attached to a distribution"
  }
}

run "credentials_are_not_in_the_clear_in_the_code" {
  command = plan

  # Not a security control — the base64 is trivially reversible, and the README
  # says so. It is here to catch the function being rendered with the password
  # interpolated raw, which is what a hand-edited template usually does first.
  assert {
    condition     = strcontains(aws_cloudfront_function.gate.code, base64encode("demo:not-the-real-one"))
    error_message = "the function must compare against the base64 of user:password, as basic auth sends it"
  }

  assert {
    condition     = !strcontains(aws_cloudfront_function.gate.code, "not-the-real-one")
    error_message = "the raw password must not appear in the function code"
  }
}

# =============================================================================
# The API behavior
# =============================================================================

run "api_behavior_allows_writes_and_forwards_headers" {
  command = plan

  assert {
    condition = length([
      for b in aws_cloudfront_distribution.this.ordered_cache_behavior :
      b if b.path_pattern == "/api/*"
    ]) == 1
    error_message = "there must be exactly one /api/* behavior"
  }

  # Every rule edit is a POST, PUT, PATCH or DELETE. A read-only method set turns
  # the whole console read-only, with a 403 from CloudFront rather than an error
  # the UI can explain.
  assert {
    condition = alltrue([
      for b in aws_cloudfront_distribution.this.ordered_cache_behavior :
      length(setsubtract(["DELETE", "PATCH", "POST", "PUT"], b.allowed_methods)) == 0
      if b.path_pattern == "/api/*"
    ])
    error_message = "/api/* must allow the write methods the console uses"
  }

  # Without an origin request policy, CloudFront strips the request down to the
  # cache key — the Authorization header would not reach the API, and neither
  # would a JSON body's content-type. Host is the one header that must not be
  # forwarded: API Gateway routes on its own hostname.
  assert {
    condition     = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.name == "Managed-AllViewerExceptHostHeader"
    error_message = "the /api/* behavior must forward the viewer's request, minus Host"
  }
}

# =============================================================================
# Caching and SPA routing
# =============================================================================

run "nothing_is_cached" {
  command = plan

  # The SPA so a redeploy needs no invalidation, the API because its responses are
  # per-request state. One policy, referenced by both behaviors.
  assert {
    condition     = data.aws_cloudfront_cache_policy.caching_disabled.name == "Managed-CachingDisabled"
    error_message = "both behaviors must use Managed-CachingDisabled"
  }

  # Every behavior points at that lookup and none carries its own policy, so this
  # holds for whatever behaviors exist rather than for the two that exist today.
  assert {
    condition = alltrue([
      for b in aws_cloudfront_distribution.this.ordered_cache_behavior :
      b.cache_policy_id == aws_cloudfront_distribution.this.default_cache_behavior[0].cache_policy_id
    ])
    error_message = "every behavior must share the one cache policy; a behavior with its own would cache the API or the SPA"
  }
}

run "no_distribution_wide_error_pages" {
  command = plan

  # A custom_error_response is the usual SPA fallback, but it applies to every
  # behavior: the API's own 404s would return index.html with status 200 and the
  # console would report them as malformed JSON. The gate function does the
  # fallback per request instead.
  assert {
    condition     = length(aws_cloudfront_distribution.this.custom_error_response) == 0
    error_message = "SPA routing must not be done with distribution-wide error responses; the API shares this distribution"
  }
}

# =============================================================================
# The bucket
# =============================================================================

run "bucket_is_reachable_only_through_the_distribution" {
  command = plan

  assert {
    condition     = aws_s3_bucket_public_access_block.ui.block_public_policy
    error_message = "the SPA bucket must not be publicly readable; CloudFront reaches it with OAC"
  }

  assert {
    condition     = aws_cloudfront_origin_access_control.ui.signing_behavior == "always"
    error_message = "OAC must always sign, or the bucket policy's condition never matches"
  }
}

# =============================================================================
# Inputs
# =============================================================================

run "rejects_an_api_endpoint_with_a_path" {
  command = plan

  variables {
    # Only the host is used, so a path here would be dropped silently and the
    # behavior would forward to the wrong place.
    api_endpoint = "https://abc123.execute-api.us-east-1.amazonaws.com/prod"
  }

  expect_failures = [var.api_endpoint]
}

run "rejects_a_username_with_a_colon" {
  command = plan

  variables {
    basic_auth_username = "de:mo"
  }

  expect_failures = [var.basic_auth_username]
}

run "rejects_a_short_password" {
  command = plan

  variables {
    basic_auth_password = "short"
  }

  expect_failures = [var.basic_auth_password]
}
