variable "table_name" {
  type        = string
  description = "DynamoDB table name. No naming convention is imposed; any valid DynamoDB table name is accepted."

  validation {
    condition     = can(regex("^[a-zA-Z0-9_.-]{3,255}$", var.table_name))
    error_message = "table_name must be 3-255 characters from [a-zA-Z0-9_.-] (DynamoDB naming rules)."
  }
}

variable "region" {
  type        = string
  default     = null
  description = "AWS region for the table. Defaults to the provider's region. Single region — Global Tables are out of scope."
}

variable "deletion_protection" {
  type        = bool
  default     = true
  description = "Enable deletion protection on the DynamoDB table."
}

variable "tags" {
  type        = map(string)
  default     = {}
  description = "Tags to apply to the DynamoDB table."
}
