variable "region" {
  type        = string
  default     = "us-east-1"
  description = "Region for the table, S3 origin, and CloudFront API calls. The Lambda@Edge is always us-east-1."
}

variable "table_name" {
  type        = string
  default     = "edgeroute-example-rules"
  description = "Name of the demo DynamoDB rules table."
}

variable "function_name" {
  type        = string
  default     = "edgeroute-example-redirect-rules"
  description = "Name of the demo Lambda@Edge function."
}

variable "origin_domain_name" {
  type        = string
  default     = null
  description = "Existing origin to put behind the distribution. Leave null to create a placeholder S3 bucket origin."
}

variable "price_class" {
  type        = string
  default     = "PriceClass_100"
  description = "CloudFront price class. PriceClass_100 (US/EU edges) keeps the demo cheap and quick to deploy."
}

variable "tags" {
  type = map(string)
  default = {
    project = "edgeroute"
    example = "infra"
  }
  description = "Tags applied to every resource in the example."
}
