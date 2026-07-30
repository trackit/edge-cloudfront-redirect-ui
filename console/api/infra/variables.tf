variable "function_name" {
  type        = string
  default     = "edgeroute-console-api"
  description = "Name of the console API Lambda and its HTTP API."

  validation {
    condition     = can(regex("^[a-zA-Z0-9-_]{1,64}$", var.function_name))
    error_message = "function_name must be 1-64 characters from [a-zA-Z0-9-_] (Lambda naming rules)."
  }
}

variable "targets_table_name" {
  type        = string
  default     = null
  description = "Name of the targets registry DynamoDB table. Defaults to <function_name>-targets."
}

variable "timeout" {
  type        = number
  default     = 10
  description = "Lambda timeout in seconds."
}

variable "memory_size" {
  type        = number
  default     = 256
  description = "Lambda memory in MB."
}

variable "log_retention_days" {
  type        = number
  default     = 14
  description = "CloudWatch log retention for the function."
}

variable "api_source_dir" {
  type        = string
  default     = null
  description = "Path to the console/api workspace. Defaults to .. relative to this module."
}

variable "monorepo_root" {
  type        = string
  default     = null
  description = "Repo root where the dependency install runs (console/api is an npm workspace). Defaults to ../../.. relative to this module."
}

variable "npm_install_command" {
  type = string
  # nullable = false so an explicit `null` falls back to the default. The path
  # variables above are deliberately `default = null` + coalesce, so passing
  # null here to mean "use the default" is the convention this file sets — and
  # without this it would reach trimspace() as null and fail the plan.
  nullable    = false
  default     = "npm ci"
  description = "Dependency install run at monorepo_root before the build. `npm ci` deletes and reinstalls node_modules, so an apply from a working repo wipes the operator's install — set this to \"npm install\" to keep it, or to \"\" to skip installing and build with whatever is already there."
}

variable "deletion_protection" {
  type        = bool
  default     = true
  description = "Deletion protection on the targets registry table. On by default — the table is the only record of which rules table each target points at."
}

variable "assumable_role_arns" {
  type        = list(string)
  default     = []
  description = "Role ARNs (wildcards allowed) the API may assume to reach a target's rules table, matching the `roleArn` on registered targets. Empty means no sts:AssumeRole grant, so the API can only reach tables its own policy covers. Keep these as narrow as your role-naming convention allows."
}

variable "allowed_regions" {
  type        = list(string)
  default     = []
  description = "Regions a target may name, passed to the Lambda as ALLOWED_REGIONS. Empty uses the API's built-in list of commercial regions, which both ages and includes opt-in regions your account may not have enabled. Set this to the regions this deployment can actually reach."
}

variable "tags" {
  type        = map(string)
  default     = {}
  description = "Tags to apply to all resources."
}
