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

# Rewrites do not work unless this header reaches origin-request, and CloudFront
# only forwards what the cache policy or the origin request policy names — a header
# added at viewer-request is otherwise dropped in between. Exposed so a consumer
# builds its origin request policy from this rather than retyping the name.
#
# Kept in step with VIEWER_HOST_HEADER in infra/lambda/src/lib/viewer-host.ts by
# hand: Terraform cannot read the TypeScript constant, and the handler cannot read
# this. Change one, change the other.
output "viewer_host_header" {
  value       = "x-edgeroute-viewer-host"
  description = "Header the function stamps the viewer's hostname into at viewer-request and reads at origin-request. Your cache behavior must forward it to the origin, or no rewrite rule will ever match."
}
