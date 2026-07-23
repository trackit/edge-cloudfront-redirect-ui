output "table_name" {
  value       = aws_dynamodb_table.this.name
  description = "DynamoDB table name. Consumed by the Lambda@Edge build config and the console API."
}

output "table_arn" {
  value       = aws_dynamodb_table.this.arn
  description = "DynamoDB table ARN. Consumed by the Lambda@Edge IAM read policy."
}

output "table_region" {
  value       = aws_dynamodb_table.this.region
  description = "AWS region the table lives in. Consumed by the Lambda@Edge build config and the console API."
}
