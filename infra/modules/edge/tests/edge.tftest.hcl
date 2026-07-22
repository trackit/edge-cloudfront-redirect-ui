# Plan-only, mocked provider. command = plan means the local-exec build never
# runs, so the suite stays hermetic (no npm, no AWS). Assertions target values
# the module sets directly — provider-computed values (e.g. rendered IAM JSON)
# are mocked and not meaningful here.
# The module only uses aws.use1, but terraform test still wires up a default aws
# provider — mock both so no real credentials are needed. The policy-document
# data source is mocked to valid JSON so aws_iam_role accepts it (policy content
# isn't asserted here — it's provider-computed and not meaningful under a mock).
mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{}"
    }
  }
}

mock_provider "aws" {
  alias = "use1"
}

variables {
  table_name   = "edgeroute-redirect-rules"
  table_arn    = "arn:aws:dynamodb:us-east-1:123456789012:table/edgeroute-redirect-rules"
  table_region = "us-east-1"
}

# =============================================================================
# Function packaging
# =============================================================================

run "runtime_and_limits" {
  command = plan

  assert {
    condition     = aws_lambda_function.this.runtime == "nodejs20.x"
    error_message = "runtime must be nodejs20.x"
  }

  assert {
    condition     = aws_lambda_function.this.handler == "index.handler"
    error_message = "handler must be index.handler"
  }

  # viewer-request association caps: 5s timeout, 128 MB memory.
  assert {
    condition     = aws_lambda_function.this.timeout == 5
    error_message = "timeout must be 5s to satisfy the viewer-request limit"
  }

  assert {
    condition     = aws_lambda_function.this.memory_size == 128
    error_message = "memory must be 128 MB to satisfy the viewer-request limit"
  }
}

run "publishes_a_version" {
  command = plan

  assert {
    condition     = aws_lambda_function.this.publish == true
    error_message = "must publish a version — CloudFront needs a qualified ARN, never $LATEST"
  }
}

run "function_name_passthrough" {
  command = plan

  variables {
    function_name = "custom-edge-fn"
  }

  assert {
    condition     = aws_lambda_function.this.function_name == "custom-edge-fn"
    error_message = "function_name output should match input"
  }
}

# =============================================================================
# Baked config (rendered into the bundle)
# =============================================================================

run "bakes_table_coordinates" {
  command = plan

  assert {
    condition     = strcontains(local_file.generated_config.content, "tableName: \"edgeroute-redirect-rules\"")
    error_message = "table name must be baked into the generated config"
  }

  assert {
    condition     = strcontains(local_file.generated_config.content, "tableRegion: \"us-east-1\"")
    error_message = "table region must be baked into the generated config"
  }

  assert {
    condition     = strcontains(local_file.generated_config.content, "cacheTtlMs: 60000")
    error_message = "cache TTL must default to 60000ms in the generated config"
  }
}

run "cache_ttl_override_is_baked" {
  command = plan

  variables {
    cache_ttl_ms = 30000
  }

  assert {
    condition     = strcontains(local_file.generated_config.content, "cacheTtlMs: 30000")
    error_message = "cache_ttl_ms override should be baked into the generated config"
  }
}

# =============================================================================
# Validation failures
# =============================================================================

run "function_name_rejects_bad_chars" {
  command = plan

  variables {
    function_name = "bad name!"
  }

  expect_failures = [var.function_name]
}

run "cache_ttl_rejects_negative" {
  command = plan

  variables {
    cache_ttl_ms = -1
  }

  expect_failures = [var.cache_ttl_ms]
}
