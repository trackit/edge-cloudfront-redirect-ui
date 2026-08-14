variable "name" {
  type        = string
  default     = "edgeroute-console"
  description = "Name prefix for the bucket, the CloudFront Function and the tags."

  validation {
    condition     = can(regex("^[a-z0-9-]{1,50}$", var.name))
    error_message = "name must be 1-50 characters from [a-z0-9-] — it prefixes an S3 bucket name."
  }
}

variable "api_endpoint" {
  type        = string
  description = "Base URL of the console API's HTTP API — the `api_endpoint` output of console/api/infra. Only its host is used; the /api/* behavior forwards to it."

  validation {
    # The host is pulled out of this with a regex, and a value carrying a path
    # would silently produce an origin the distribution cannot reach.
    condition     = can(regex("^https://[a-z0-9.-]+/?$", var.api_endpoint))
    error_message = "api_endpoint must be https:// followed by a host and nothing else, e.g. https://abc123.execute-api.us-east-1.amazonaws.com."
  }
}

variable "basic_auth_username" {
  type        = string
  description = "Username for the console's basic-auth prompt. Login is post-MVP; this is what keeps an unauthenticated console off the open internet."

  validation {
    # Basic auth sends `user:password` base64-encoded, so a colon in the username
    # moves where the password starts and nothing can log in.
    condition     = length(var.basic_auth_username) > 0 && !strcontains(var.basic_auth_username, ":")
    error_message = "basic_auth_username must be non-empty and must not contain a colon."
  }
}

variable "basic_auth_password" {
  type        = string
  sensitive   = true
  description = "Password for the console's basic-auth prompt. Ends up in the CloudFront Function's code and in state — treat it as a demo credential, not a secret."

  validation {
    condition     = length(var.basic_auth_password) >= 12
    error_message = "basic_auth_password must be at least 12 characters. It guards a console that can rewrite live traffic, and it is the only thing doing so."
  }
}

variable "ui_source_dir" {
  type        = string
  default     = null
  description = "Path to the console/ui workspace. Defaults to .. relative to this module."
}

variable "monorepo_root" {
  type        = string
  default     = null
  description = "Repo root where the dependency install runs (console/ui is an npm workspace). Defaults to ../../.. relative to this module."
}

variable "npm_install_command" {
  type = string
  # nullable = false so an explicit `null` falls back to the default, matching
  # console/api/infra.
  nullable    = false
  default     = "npm ci"
  description = "Dependency install run at monorepo_root before the build. `npm ci` deletes and reinstalls node_modules, so an apply from a working repo wipes the operator's install — set this to \"npm install\" to keep it, or to \"\" to skip installing and build with whatever is already there."
}

variable "price_class" {
  type        = string
  default     = "PriceClass_100"
  description = "CloudFront price class. PriceClass_100 (US/EU edges) keeps a demo console cheap."
}

variable "tags" {
  type        = map(string)
  default     = {}
  description = "Tags to apply to all resources."
}
