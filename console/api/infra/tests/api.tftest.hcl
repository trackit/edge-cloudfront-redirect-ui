# Plan-only, mocked provider. command = plan means the local-exec build never
# runs and the archive data source (deferred via depends_on) is never read, so
# the suite stays hermetic — no npm, no AWS. Assertions target values the module
# sets directly; provider-computed values are mocked and not meaningful here.
# The policy-document data source is mocked to valid JSON so aws_iam_role
# accepts it; policy content is provider-computed and not asserted here.
# `cognito_domain_prefix` has no default on purpose — the prefix is globally
# unique across AWS, so shipping one would collide for the second person to
# apply this. The suite supplies a throwaway.
variables {
  cognito_domain_prefix = "edgeroute-console-api-test"
}

mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{}"
    }
  }

  # Pinned, unlike the rest of the mocks: these two are interpolated into a
  # policy resource this suite asserts on by value.
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
    }
  }

  mock_data "aws_partition" {
    defaults = {
      partition = "aws"
    }
  }

  # Pinned for the same reason: the hosted UI's URL is built from it.
  mock_data "aws_region" {
    defaults = {
      region = "us-east-1"
    }
  }
}

run "lambda_runtime_and_handler" {
  command = plan

  assert {
    condition     = aws_lambda_function.this.runtime == "nodejs22.x"
    error_message = "runtime must be a supported Node runtime; nodejs20.x reached end of support"
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
  # statement and not a further, broader one. Three, because DescribeTargetTables
  # is unconditional — it is asserted on its own in
  # describe_table_is_granted_across_the_account.
  assert {
    condition     = length(data.aws_iam_policy_document.registry.statement) == 3
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

run "rejects_a_bare_wildcard_assumable_role" {
  command = plan

  # With no auth until ER-205, "*" would let any caller point the API anywhere.
  variables {
    assumable_role_arns = ["*"]
  }

  expect_failures = [var.assumable_role_arns]
}

run "rejects_a_cross_account_assumable_role" {
  command = plan

  # The dangerous form an exact-match guard would miss: shaped like an ARN but
  # spanning every account.
  variables {
    assumable_role_arns = ["arn:aws:iam::*:role/*"]
  }

  expect_failures = [var.assumable_role_arns]
}

run "rejects_assuming_any_role_in_the_account" {
  command = plan

  # Shaped like a scoped ARN with a literal account, but the role name is a bare
  # wildcard — i.e. assume anything in the account. The account check alone
  # does not catch this.
  variables {
    assumable_role_arns = ["arn:aws:iam::123456789012:role/*"]
  }

  expect_failures = [var.assumable_role_arns]
}

run "rejects_every_table_in_the_account" {
  command = plan

  # The same hole on the more dangerous variable: this grant is direct, so
  # `table/*` means PutItem/DeleteItem on every table in the account.
  variables {
    target_table_arns = ["arn:aws:dynamodb:*:123456789012:table/*"]
  }

  expect_failures = [var.target_table_arns]
}

run "rejects_a_single_character_wildcard_role" {
  command = plan

  # IAM treats `?` as a single-character wildcard, so this matches every
  # 14-character role in the account. A guard that only blocks `*` misses it.
  variables {
    assumable_role_arns = ["arn:aws:iam::123456789012:role/??????????????"]
  }

  expect_failures = [var.assumable_role_arns]
}

run "rejects_a_single_character_wildcard_table" {
  command = plan

  variables {
    target_table_arns = ["arn:aws:dynamodb:us-east-1:123456789012:table/????????????????"]
  }

  expect_failures = [var.target_table_arns]
}

run "allows_a_role_path" {
  command = plan

  # Roles can carry a path; that must not be mistaken for a wildcard.
  variables {
    assumable_role_arns = ["arn:aws:iam::123456789012:role/service-roles/edgeroute-target-prod"]
  }

  assert {
    condition = length([
      for s in data.aws_iam_policy_document.registry.statement :
      s if s.sid == "AssumeTargetRoles"
    ]) == 1
    error_message = "a role ARN with a path must be accepted"
  }
}

run "allows_a_role_name_wildcard" {
  command = plan

  # A wildcard in the role *name* is how a naming convention is expressed.
  variables {
    assumable_role_arns = ["arn:aws:iam::123456789012:role/edgeroute-target-*"]
  }

  assert {
    condition = length([
      for s in data.aws_iam_policy_document.registry.statement :
      s if s.sid == "AssumeTargetRoles"
    ]) == 1
    error_message = "a role-name wildcard with a literal account must be accepted"
  }
}

run "rejects_a_bare_wildcard_target_table" {
  command = plan

  # Worse than the AssumeRole case: this grant is direct, so "*" would mean
  # PutItem/DeleteItem on every table in the account.
  variables {
    target_table_arns = ["*"]
  }

  expect_failures = [var.target_table_arns]
}

run "rejects_a_cross_account_target_table" {
  command = plan

  variables {
    target_table_arns = ["arn:aws:dynamodb:*:*:table/*"]
  }

  expect_failures = [var.target_table_arns]
}

run "allows_a_region_and_table_name_wildcard" {
  command = plan

  # Multi-region targets are a real case; only the account must be literal.
  variables {
    target_table_arns = ["arn:aws:dynamodb:*:123456789012:table/edgeroute-rules-*"]
  }

  assert {
    condition = length([
      for s in data.aws_iam_policy_document.registry.statement :
      s if s.sid == "TargetRulesTables"
    ]) == 1
    error_message = "a region/table wildcard with a literal account must be accepted"
  }
}

run "no_rules_table_grant_by_default" {
  command = plan

  # Default grants access to no rules table, so every target needs a roleArn.
  assert {
    condition = length([
      for s in data.aws_iam_policy_document.registry.statement :
      s if s.sid == "TargetRulesTables"
    ]) == 0
    error_message = "rules-table access must be opt-in via target_table_arns"
  }
}

run "target_table_arns_grants_the_listed_tables" {
  command = plan

  # The alternative to a per-target role: a target with no roleArn is only
  # reachable if its table is named here at apply time.
  variables {
    target_table_arns = ["arn:aws:dynamodb:us-east-1:123456789012:table/rules-prod"]
  }

  # The count guard is load-bearing: `alltrue([])` is true, so without it every
  # assertion below would pass if the statement were deleted or its sid renamed —
  # including the DeleteTable guard, which is criterion 6's safety net.
  assert {
    condition = length([
      for s in data.aws_iam_policy_document.registry.statement :
      s if s.sid == "TargetRulesTables"
    ]) == 1
    error_message = "target_table_arns must add exactly one TargetRulesTables statement"
  }

  assert {
    condition = alltrue([
      for s in data.aws_iam_policy_document.registry.statement :
      s.resources == toset([
        "arn:aws:dynamodb:us-east-1:123456789012:table/rules-prod"
      ])
      if s.sid == "TargetRulesTables"
    ])
    error_message = "rules-table access must be scoped to exactly target_table_arns"
  }

  # Item-level actions only — never DeleteTable, which criterion 6 forbids.
  assert {
    condition = alltrue([
      for s in data.aws_iam_policy_document.registry.statement :
      !contains(s.actions, "dynamodb:DeleteTable")
      if s.sid == "TargetRulesTables"
    ])
    error_message = "the rules-table grant must never include DeleteTable"
  }

  # And every call the rule routes actually make. Asserting only what is
  # forbidden let the `disabled` toggle ship against a policy with no UpdateItem,
  # where the symptom is an AccessDenied at runtime that reads like a
  # connectivity problem. A dropped action fails here instead.
  assert {
    condition = alltrue([
      for s in data.aws_iam_policy_document.registry.statement :
      alltrue([
        for action in [
          "dynamodb:Query",      # list a host's rules
          "dynamodb:GetItem",    # fetch one
          "dynamodb:PutItem",    # create, replace, and the move's Put leg
          "dynamodb:UpdateItem", # the disabled toggle
          "dynamodb:DeleteItem", # delete, and the move's Delete leg
          # Deleting a host. Its own IAM action, not implied by DeleteItem.
          "dynamodb:BatchWriteItem",
        ] : contains(s.actions, action)
      ])
      if s.sid == "TargetRulesTables"
    ])
    error_message = "the rules-table grant must cover every DynamoDB call the rule routes make"
  }
}

# The registration check's grant. Separate from TargetRulesTables and never
# scoped to it: the names it has to answer for are the ones that were typed
# wrong, which by definition are not in the list of tables that should exist.
run "describe_table_is_granted_across_the_account" {
  command = plan

  # No target_table_arns and no assumable_role_arns — a fresh deployment, where
  # the typo check still has to work.
  assert {
    condition = length([
      for s in data.aws_iam_policy_document.registry.statement :
      s if s.sid == "DescribeTargetTables"
    ]) == 1
    error_message = "the registration check needs exactly one DescribeTargetTables statement, unconditionally"
  }

  assert {
    condition = alltrue([
      for s in data.aws_iam_policy_document.registry.statement :
      s.resources == toset(["arn:aws:dynamodb:*:123456789012:table/*"])
      if s.sid == "DescribeTargetTables"
    ])
    error_message = "DescribeTable must cover every table in this account and region, or a mistyped name reads as AccessDenied and is allowed through"
  }

  # The wildcard resource is why this is asserted as an exact set rather than a
  # `contains`: DescribeTable is read-only metadata and safe account-wide, and
  # nothing else may be added here without narrowing the resource first.
  assert {
    condition = alltrue([
      for s in data.aws_iam_policy_document.registry.statement :
      s.actions == toset(["dynamodb:DescribeTable"])
      if s.sid == "DescribeTargetTables"
    ])
    error_message = "the account-wide statement must grant DescribeTable and nothing else"
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

run "pool_is_admin_create_only" {
  command = plan

  assert {
    condition     = aws_cognito_user_pool.this.admin_create_user_config[0].allow_admin_create_user_only
    error_message = "self sign-up must stay off: this API can repoint production traffic, so an open registration form is not something to leave to a default"
  }

  assert {
    condition     = aws_cognito_user_pool.this.password_policy[0].minimum_length >= 12
    error_message = "password policy must require at least 12 characters"
  }
}

run "client_is_confidential_and_code_only" {
  command = plan

  assert {
    condition     = aws_cognito_user_pool_client.console.generate_secret
    error_message = "the client must have a secret: the API performs the code exchange so the browser never holds one, which is what keeps the refresh token out of JavaScript"
  }

  assert {
    condition     = aws_cognito_user_pool_client.console.allowed_oauth_flows == toset(["code"])
    error_message = "only the authorization code flow may be enabled; implicit returns tokens in the URL fragment"
  }

  assert {
    condition     = !contains(aws_cognito_user_pool_client.console.explicit_auth_flows, "ALLOW_USER_PASSWORD_AUTH")
    error_message = "USER_PASSWORD_AUTH would let anything trade a password for a token outside the hosted UI"
  }
}

run "both_roles_exist_as_groups" {
  command = plan

  assert {
    condition     = aws_cognito_user_group.viewer.name == "viewer"
    error_message = "the viewer group is the read-only role the router checks for"
  }

  assert {
    condition     = aws_cognito_user_group.editor.name == "editor"
    error_message = "the editor group is the role that may write"
  }
}

run "authorizer_accepts_only_this_pool_and_client" {
  command = plan

  assert {
    condition     = aws_apigatewayv2_authorizer.jwt.authorizer_type == "JWT"
    error_message = "the authorizer must validate JWTs; a REQUEST authorizer would mean writing the validation ourselves"
  }

  assert {
    condition     = aws_apigatewayv2_authorizer.jwt.identity_sources == toset(["$request.header.Authorization"])
    error_message = "the token is read from the Authorization header"
  }

  assert {
    condition     = length(aws_apigatewayv2_authorizer.jwt.jwt_configuration[0].audience) == 1
    error_message = "the audience must name exactly this app client, or a token minted for another client of the same pool would be accepted"
  }
}

run "default_route_requires_a_token" {
  command = plan

  assert {
    condition     = aws_apigatewayv2_route.default.authorization_type == "JWT"
    error_message = "every route the public list does not name must require a token; $default is the catch-all the Lambda's router dispatches"
  }
}

run "only_health_and_auth_are_public" {
  command = plan

  # Named exactly rather than counted: a route added here is reachable without a
  # token, so the test should fail until someone states which one and why.
  assert {
    condition = toset(keys(aws_apigatewayv2_route.public)) == toset([
      "GET /health",
      "POST /auth/session",
      "POST /auth/refresh",
      "POST /auth/logout",
    ])
    error_message = "the unauthenticated route set changed: /health is for uptime checks and the /auth routes are the exchange that issues a token, so requiring one would be circular. Anything else needs a reason."
  }

  assert {
    condition = alltrue([
      for route in aws_apigatewayv2_route.public : route.authorization_type == "NONE"
    ])
    error_message = "the public routes must opt out explicitly; inheriting the default would make them unreachable before login"
  }
}

run "callback_urls_reject_plain_http" {
  command = plan

  variables {
    auth_callback_urls = ["http://console.example.com/auth/callback"]
  }

  expect_failures = [var.auth_callback_urls]
}

run "callback_urls_allow_localhost_for_dev" {
  command = plan

  variables {
    auth_callback_urls = ["http://localhost:5180/auth/callback"]
  }

  assert {
    condition     = length(aws_cognito_user_pool_client.console.callback_urls) == 1
    error_message = "http on localhost is the one exception Cognito makes, and it is what makes the flow testable before anything is deployed"
  }
}

run "no_identity_provider_by_default" {
  command = plan

  # The default that matters for a tool other people deploy: a working pool with
  # its own accounts, no third party, and no federated-MAU billing until someone
  # opts in.
  assert {
    condition     = length(aws_cognito_identity_provider.sso) == 0
    error_message = "no identity provider should exist unless a deployment names one"
  }

  assert {
    condition     = aws_cognito_user_pool_client.console.supported_identity_providers == toset(["COGNITO"])
    error_message = "with no provider configured the pool's own accounts are the only way in"
  }
}

run "an_oidc_provider_is_added_alongside_cognito" {
  command = plan

  variables {
    identity_provider = {
      name          = "Okta"
      issuer        = "https://example.okta.com"
      client_id     = "okta-client"
      client_secret = "okta-secret"
    }
  }

  assert {
    condition     = aws_cognito_identity_provider.sso["sso"].provider_type == "OIDC"
    error_message = "OIDC covers Google, Okta, Auth0, Entra ID and Keycloak from the same four inputs; SAML would need per-provider metadata"
  }

  # Alongside, not instead of: a deployment that adds SSO usually still wants an
  # account that works when the provider is down or misconfigured.
  assert {
    condition     = aws_cognito_user_pool_client.console.supported_identity_providers == toset(["COGNITO", "Okta"])
    error_message = "the configured provider should be offered in addition to the pool's own accounts"
  }

  assert {
    condition     = aws_cognito_identity_provider.sso["sso"].provider_details.authorize_scopes == "openid email profile"
    error_message = "scopes default to the three the console needs and are space-joined as OIDC expects"
  }

  assert {
    condition     = aws_cognito_identity_provider.sso["sso"].attribute_mapping.email == "email"
    error_message = "email must map through: it is this pool's username attribute, so a provider that does not supply it cannot create a user"
  }
}

run "a_provider_issuer_must_be_https" {
  command = plan

  variables {
    identity_provider = {
      name          = "Okta"
      issuer        = "http://example.okta.com"
      client_id     = "c"
      client_secret = "s"
    }
  }

  expect_failures = [var.identity_provider]
}

run "a_provider_may_not_take_a_reserved_name" {
  command = plan

  variables {
    identity_provider = {
      name          = "Google"
      issuer        = "https://accounts.google.com"
      client_id     = "c"
      client_secret = "s"
    }
  }

  # Cognito keeps these for its own social providers, and the failure it gives
  # for reusing one is not obvious from the message.
  expect_failures = [var.identity_provider]
}
