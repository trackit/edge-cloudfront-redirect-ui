variable "function_name" {
  type        = string
  default     = "edgeroute-console-api"
  description = "Name of the console API Lambda and its HTTP API."

  validation {
    condition     = can(regex("^[a-zA-Z0-9-_]{1,64}$", var.function_name))
    error_message = "function_name must be 1-64 characters from [a-zA-Z0-9-_] (Lambda naming rules)."
  }
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

variable "tags" {
  type        = map(string)
  default     = {}
  description = "Tags to apply to all resources."
}
