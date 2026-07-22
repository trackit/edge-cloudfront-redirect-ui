variable "function_name" {
  type        = string
  default     = "edgeroute-redirect-rules"
  description = "Name of the published Lambda@Edge function."

  validation {
    condition     = can(regex("^[a-zA-Z0-9-_]{1,64}$", var.function_name))
    error_message = "function_name must be 1-64 characters from [a-zA-Z0-9-_] (Lambda naming rules)."
  }
}

variable "table_name" {
  type        = string
  description = "DynamoDB rules table name. Baked into the bundle and read by the handler at the edge."
}

variable "table_arn" {
  type        = string
  description = "DynamoDB rules table ARN. Scopes the Lambda's read-only IAM policy."
}

variable "table_region" {
  type        = string
  description = "AWS region the DynamoDB table lives in. Baked into the bundle so the edge reads the right region."
}

variable "cache_ttl_ms" {
  type        = number
  default     = 60000
  description = "In-memory rule cache TTL (ms) baked into the bundle. ~1 min propagation is the documented default."

  validation {
    condition     = var.cache_ttl_ms >= 0
    error_message = "cache_ttl_ms must be a non-negative number."
  }
}

variable "lambda_source_dir" {
  type        = string
  default     = null
  description = "Path to the infra/lambda workspace. Defaults to ../../lambda relative to this module."
}

variable "monorepo_root" {
  type        = string
  default     = null
  description = "Repo root where `npm ci` runs (infra/lambda is an npm workspace). Defaults to ../../.. relative to this module."
}

variable "tags" {
  type        = map(string)
  default     = {}
  description = "Tags to apply to the Lambda function and IAM role."
}
