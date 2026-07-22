# One function serves both associations (it dispatches on cf.config.eventType),
# so both ARNs below are the same qualified version ARN.
output "lambda_qualified_arn" {
  value       = aws_lambda_function.this.qualified_arn
  description = "Published version ARN of the Lambda@Edge function."
}

output "viewer_request_lambda_arn" {
  value       = aws_lambda_function.this.qualified_arn
  description = "Qualified ARN for the viewer-request association (redirects)."
}

output "origin_request_lambda_arn" {
  value       = aws_lambda_function.this.qualified_arn
  description = "Qualified ARN for the origin-request association (rewrites)."
}

output "function_name" {
  value       = aws_lambda_function.this.function_name
  description = "Name of the published Lambda@Edge function."
}

output "role_arn" {
  value       = aws_iam_role.this.arn
  description = "ARN of the Lambda execution role."
}
