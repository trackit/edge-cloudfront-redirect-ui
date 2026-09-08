output "console_url" {
  value       = "https://${aws_cloudfront_distribution.this.domain_name}"
  description = "Where the console is served."
}

output "distribution_id" {
  value       = aws_cloudfront_distribution.this.id
  description = "Distribution ID, for `aws cloudfront get-distribution` or a manual invalidation."
}

output "distribution_domain_name" {
  value       = aws_cloudfront_distribution.this.domain_name
  description = "The distribution's own domain, without the scheme."
}

output "bucket_name" {
  value       = aws_s3_bucket.ui.id
  description = "Bucket the built SPA is synced to."
}

output "function_arn" {
  value       = aws_cloudfront_function.gate.arn
  description = "ARN of the gate function (/api strip, SPA fallback)."
}

output "api_health_command" {
  value       = "curl -i https://${aws_cloudfront_distribution.this.domain_name}/api/health"
  description = "Checks the console can reach the API through the /api/* behavior. Expect {\"status\":\"ok\"}."
}
