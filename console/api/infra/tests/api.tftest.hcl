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
