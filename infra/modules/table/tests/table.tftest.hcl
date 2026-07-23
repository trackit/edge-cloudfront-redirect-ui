mock_provider "aws" {}

# =============================================================================
# Happy paths
# =============================================================================

run "schema_and_billing" {
  command = plan

  variables {
    table_name = "edgeroute-redirect-rules"
  }

  assert {
    condition     = aws_dynamodb_table.this.hash_key == "pk"
    error_message = "partition key must be pk (host)"
  }

  assert {
    condition     = aws_dynamodb_table.this.range_key == "sk"
    error_message = "sort key must be sk (TYPE#priority)"
  }

  assert {
    condition     = one([for a in aws_dynamodb_table.this.attribute : a if a.name == "pk"]).type == "S"
    error_message = "pk attribute must be type String"
  }

  assert {
    condition     = one([for a in aws_dynamodb_table.this.attribute : a if a.name == "sk"]).type == "S"
    error_message = "sk attribute must be type String"
  }

  assert {
    condition     = aws_dynamodb_table.this.billing_mode == "PAY_PER_REQUEST"
    error_message = "billing_mode should be PAY_PER_REQUEST"
  }
}

run "pitr_enabled" {
  command = plan

  variables {
    table_name = "edgeroute-redirect-rules"
  }

  assert {
    condition     = one(aws_dynamodb_table.this.point_in_time_recovery).enabled == true
    error_message = "point-in-time recovery must be enabled"
  }
}

run "region_passthrough" {
  command = plan

  variables {
    table_name = "edgeroute-redirect-rules"
    region     = "us-west-2"
  }

  assert {
    condition     = aws_dynamodb_table.this.region == "us-west-2"
    error_message = "region should be set from the region variable"
  }
}

run "table_name_output" {
  command = plan

  variables {
    table_name = "edgeroute-redirect-rules"
  }

  assert {
    condition     = output.table_name == "edgeroute-redirect-rules"
    error_message = "table_name output should match input"
  }
}

run "deletion_protection_defaults_true" {
  command = plan

  variables {
    table_name = "edgeroute-redirect-rules"
  }

  assert {
    condition     = aws_dynamodb_table.this.deletion_protection_enabled == true
    error_message = "deletion_protection should default to true"
  }
}

run "deletion_protection_can_be_disabled" {
  command = plan

  variables {
    table_name          = "edgeroute-redirect-rules"
    deletion_protection = false
  }

  assert {
    condition     = aws_dynamodb_table.this.deletion_protection_enabled == false
    error_message = "deletion_protection should be false when explicitly disabled"
  }
}

run "tags_applied_verbatim" {
  command = plan

  variables {
    table_name = "edgeroute-redirect-rules"
    tags       = { environment = "prod", team = "edge" }
  }

  assert {
    condition     = aws_dynamodb_table.this.tags["environment"] == "prod"
    error_message = "caller tags should be applied as-is"
  }

  assert {
    condition     = aws_dynamodb_table.this.tags["team"] == "edge"
    error_message = "caller tags should be applied as-is"
  }
}

# =============================================================================
# Validation failures
# =============================================================================

run "table_name_too_short" {
  command = plan

  variables {
    table_name = "ab"
  }

  expect_failures = [var.table_name]
}

run "table_name_too_long" {
  command = plan

  variables {
    table_name = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }

  expect_failures = [var.table_name]
}

run "table_name_with_space" {
  command = plan

  variables {
    table_name = "invalid name"
  }

  expect_failures = [var.table_name]
}
