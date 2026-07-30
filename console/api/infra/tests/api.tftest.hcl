# Plan-only, mocked provider. command = plan means the local-exec build never
# runs and the archive data source (deferred via depends_on) is never read, so
# the suite stays hermetic — no npm, no AWS. Assertions target values the module
# sets directly; provider-computed values are mocked and not meaningful here.
# The policy-document data source is mocked to valid JSON so aws_iam_role
# accepts it; policy content is provider-computed and not asserted here.
mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{}"
    }
  }
}

run "lambda_runtime_and_handler" {
  command = plan

  assert {
    condition     = aws_lambda_function.this.runtime == "nodejs20.x"
    error_message = "runtime must be nodejs20.x"
  }

  assert {
    condition     = aws_lambda_function.this.handler == "index.handler"
    error_message = "handler must be index.handler"
  }
}

run "lambda_sizing_defaults" {
  command = plan

  assert {
    condition     = aws_lambda_function.this.memory_size == 256
    error_message = "memory_size should default to 256"
  }

  assert {
    condition     = aws_lambda_function.this.timeout == 10
    error_message = "timeout should default to 10"
  }
}

run "sizing_overrides" {
  command = plan

  variables {
    memory_size = 512
    timeout     = 20
  }

  assert {
    condition     = aws_lambda_function.this.memory_size == 512
    error_message = "memory_size should follow the variable"
  }

  assert {
    condition     = aws_lambda_function.this.timeout == 20
    error_message = "timeout should follow the variable"
  }
}

run "http_api_shape" {
  command = plan

  assert {
    condition     = aws_apigatewayv2_api.this.protocol_type == "HTTP"
    error_message = "API must be an HTTP API (v2)"
  }

  assert {
    condition     = aws_apigatewayv2_integration.this.integration_type == "AWS_PROXY"
    error_message = "integration must be AWS_PROXY"
  }

  assert {
    condition     = aws_apigatewayv2_integration.this.payload_format_version == "2.0"
    error_message = "integration must use payload format 2.0"
  }

  assert {
    condition     = aws_apigatewayv2_route.default.route_key == "$default"
    error_message = "a $default catch-all route must forward every path to the Lambda"
  }

  assert {
    condition     = aws_apigatewayv2_stage.default.auto_deploy == true
    error_message = "the default stage should auto-deploy"
  }
}

run "apigw_invoke_permission" {
  command = plan

  assert {
    condition     = aws_lambda_permission.apigw.principal == "apigateway.amazonaws.com"
    error_message = "API Gateway must be allowed to invoke the Lambda"
  }
}

run "registry_table_and_env" {
  command = plan

  assert {
    condition     = aws_dynamodb_table.targets.hash_key == "id"
    error_message = "registry table must be keyed by id"
  }

  assert {
    condition     = aws_dynamodb_table.targets.billing_mode == "PAY_PER_REQUEST"
    error_message = "registry table should be PAY_PER_REQUEST"
  }

  assert {
    condition     = aws_dynamodb_table.targets.name == "edgeroute-console-api-targets"
    error_message = "registry table should default to <function_name>-targets"
  }

  assert {
    condition     = aws_lambda_function.this.environment[0].variables["TARGETS_TABLE_NAME"] == aws_dynamodb_table.targets.name
    error_message = "Lambda must receive the registry table name via TARGETS_TABLE_NAME"
  }
}

run "log_group_named_for_function" {
  command = plan

  variables {
    function_name = "my-console-api"
  }

  assert {
    condition     = aws_cloudwatch_log_group.this.name == "/aws/lambda/my-console-api"
    error_message = "log group must follow /aws/lambda/<function_name>"
  }
}

run "function_name_rejects_bad_chars" {
  command = plan

  variables {
    function_name = "bad name!"
  }

  expect_failures = [var.function_name]
}

# =============================================================================
# Reaching a target's table (ER-202)
# =============================================================================

run "registry_table_is_protected_by_default" {
  command = plan

  # The registry is the only record of which table each target points at.
  assert {
    condition     = aws_dynamodb_table.targets.deletion_protection_enabled == true
    error_message = "the targets registry must have deletion protection on by default"
  }
}

run "no_assume_role_grant_by_default" {
  command = plan

  # Default must not hand out sts:AssumeRole — the grant is opt-in and scoped.
  assert {
    condition = length([
      for s in data.aws_iam_policy_document.registry.statement :
      s if s.sid == "AssumeTargetRoles"
    ]) == 0
    error_message = "sts:AssumeRole must not be granted unless assumable_role_arns is set"
  }
}

run "assume_role_scoped_to_the_given_arns" {
  command = plan

  variables {
    assumable_role_arns = ["arn:aws:iam::123456789012:role/edgeroute-target-*"]
  }

  assert {
    condition = length([
      for s in data.aws_iam_policy_document.registry.statement :
      s if s.sid == "AssumeTargetRoles"
    ]) == 1
    error_message = "assumable_role_arns must add an AssumeTargetRoles statement"
  }

  # Never a wildcard on resources — the whole point of the per-target role.
  assert {
    condition = alltrue([
      for s in data.aws_iam_policy_document.registry.statement :
      s.resources == toset(["arn:aws:iam::123456789012:role/edgeroute-target-*"])
      if s.sid == "AssumeTargetRoles"
    ])
    error_message = "AssumeRole must be scoped to exactly the configured role ARNs"
  }
}

run "assume_role_grant_adds_nothing_else" {
  command = plan

  variables {
    assumable_role_arns = ["arn:aws:iam::123456789012:role/edgeroute-target-*"]
  }

  # The registry statement's own resources can't be asserted here — they hold the
  # provider-computed table ARN, which is unknown under a mocked plan. What is
  # knowable is the statement count: enabling the grant must add exactly one
  # statement and not a third, broader one.
  assert {
    condition     = length(data.aws_iam_policy_document.registry.statement) == 2
    error_message = "enabling assumable_role_arns must add exactly one statement"
  }

  assert {
    condition = length([
      for s in data.aws_iam_policy_document.registry.statement :
      s if s.sid == "TargetsRegistry"
    ]) == 1
    error_message = "the registry statement must survive unchanged alongside the grant"
  }
}

run "allowed_regions_passed_through_when_set" {
  command = plan

  variables {
    allowed_regions = ["us-east-1", "eu-west-1"]
  }

  assert {
    condition     = aws_lambda_function.this.environment[0].variables["ALLOWED_REGIONS"] == "us-east-1,eu-west-1"
    error_message = "allowed_regions must reach the Lambda as a comma-separated ALLOWED_REGIONS"
  }
}

run "allowed_regions_omitted_when_empty" {
  command = plan

  # Absent, not empty — the API falls back to its built-in list, and an empty
  # string would be indistinguishable from "allow nothing" if that ever changed.
  assert {
    condition     = !contains(keys(aws_lambda_function.this.environment[0].variables), "ALLOWED_REGIONS")
    error_message = "ALLOWED_REGIONS must be omitted entirely when allowed_regions is empty"
  }
}
