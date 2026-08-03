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
