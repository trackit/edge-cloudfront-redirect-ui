output "api_endpoint" {
  value       = aws_apigatewayv2_stage.default.invoke_url
  description = "Base URL of the deployed HTTP API (hit /health to check)."
}

output "function_name" {
  value       = aws_lambda_function.this.function_name
  description = "Name of the console API Lambda."
}

output "function_arn" {
  value       = aws_lambda_function.this.arn
  description = "ARN of the console API Lambda."
}

output "role_arn" {
  value       = aws_iam_role.this.arn
  description = "ARN of the Lambda execution role."
}

output "log_group_name" {
  value       = aws_cloudwatch_log_group.this.name
  description = "CloudWatch log group for the function."
}

output "targets_table_name" {
  value       = aws_dynamodb_table.targets.name
  description = "Name of the targets registry DynamoDB table."
}

output "targets_table_arn" {
  value       = aws_dynamodb_table.targets.arn
  description = "ARN of the targets registry DynamoDB table."
}

output "region" {
  value       = data.aws_region.current.region
  description = "Region this deployment is in. Read by seed-users.sh so it does not depend on the caller's configured default."
}

output "user_pool_id" {
  value       = aws_cognito_user_pool.this.id
  description = "Cognito user pool backing the console. The seed script reads this to create the demo accounts."
}

output "user_pool_client_id" {
  value       = aws_cognito_user_pool_client.console.id
  description = "App client the console authenticates through. Also the JWT audience the API Gateway authorizer accepts."
}

output "cognito_domain" {
  value       = "https://${aws_cognito_user_pool_domain.this.domain}.auth.${data.aws_region.current.region}.amazoncognito.com"
  description = "Hosted UI base URL. /login redirects here to sign in and /logout to sign out."
}
