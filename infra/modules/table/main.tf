# Suppress AVD-AWS-0025 "Table does not use a customer managed key" (LOW).
# DynamoDB encrypts all data at rest by default with an AWS-owned key.
# We accept AWS-owned encryption because the table holds CDN redirect/rewrite
# rules — not sensitive data — and a CMK adds cost (~$1/month + API calls)
# and operational complexity (key policies, rotation) for no real gain here.
# Revisit if this table starts storing sensitive data.
# Reference: https://avd.aquasec.com/misconfig/avd-aws-0025
#trivy:ignore:AVD-AWS-0025
resource "aws_dynamodb_table" "this" {
  name         = var.table_name
  region       = var.region
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  # pk = host (e.g. www.example.com)
  attribute {
    name = "pk"
    type = "S"
  }

  # sk = TYPE#priority, zero-padded (e.g. REDIRECT#00100)
  attribute {
    name = "sk"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  deletion_protection_enabled = var.deletion_protection

  tags = var.tags
}
