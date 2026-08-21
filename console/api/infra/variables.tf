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
  description = "Role ARNs the API may assume to reach a target's rules table, matching the `roleArn` on registered targets. Empty means no sts:AssumeRole grant. A trailing * is allowed in the role name; the account must be literal. Keep these as narrow as your role-naming convention allows."

  # The account must be spelled out. With no authentication until ER-205, a grant
  # that spans accounts (`*` alone, or `arn:aws:iam::*:role/*`) would let any
  # caller register a target pointing anywhere the API can reach. A trailing `*`
  # in the role *name* is fine — that is how a naming convention is expressed.
  # `?` is rejected outright: IAM treats it as a single-character wildcard, so
  # `role/??????????????` matches every 14-character role, and no legal role or
  # table name contains one anyway.
  validation {
    condition = alltrue([
      for arn in var.assumable_role_arns :
      can(regex("^arn:aws[a-z-]*:iam::[0-9]{12}:role/[^*?]+\\*?$", arn))
    ])
    error_message = "each assumable_role_arns entry must be a role ARN with a literal 12-digit account, and a role name that is literal except for an optional trailing * (no ? anywhere), e.g. arn:aws:iam::123456789012:role/edgeroute-target-*."
  }
}

variable "target_table_arns" {
  type        = list(string)
  default     = []
  description = "Rules-table ARNs the API's own execution role may read and write. The alternative to a per-target `roleArn`: a target with no roleArn is only reachable if its table is listed here. Empty means every target must carry a roleArn. The region may be a wildcard and the table name may end in *; the account must be literal."

  # Same reasoning as assumable_role_arns, and it matters more here: this grant is
  # direct rather than via AssumeRole, so a bare wildcard would hand the API
  # PutItem/DeleteItem on every table in the account, not just the rules tables.
  validation {
    condition = alltrue([
      for arn in var.target_table_arns :
      can(regex("^arn:aws[a-z-]*:dynamodb:[a-z0-9*-]+:[0-9]{12}:table/[^*?]+\\*?$", arn))
    ])
    error_message = "each target_table_arns entry must be a DynamoDB table ARN with a non-empty region and a literal 12-digit account, and a table name that is literal except for an optional trailing * (no ? anywhere), e.g. arn:aws:dynamodb:us-east-1:123456789012:table/edgeroute-rules-*."
  }
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

variable "cognito_domain_prefix" {
  type        = string
  description = "Prefix for the Cognito hosted UI domain, giving <prefix>.auth.<region>.amazoncognito.com. No default: the prefix is globally unique across all AWS accounts, so any value shipped here would collide for the second person to apply this."

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$", var.cognito_domain_prefix))
    error_message = "cognito_domain_prefix must be 3-63 characters of lowercase letters, digits and hyphens, and may not start or end with a hyphen (Cognito domain rules)."
  }
}

variable "auth_callback_urls" {
  type        = list(string)
  default     = ["http://localhost:5180/auth/callback"]
  description = "URLs Cognito may redirect to after a login. Defaults to the Vite dev server so a fresh pool is usable locally before anything is deployed; add the deployed console's /auth/callback when it exists. Cognito allows http only for localhost."

  validation {
    condition = alltrue([
      for url in var.auth_callback_urls :
      can(regex("^https://", url)) || can(regex("^http://localhost(:[0-9]+)?/", url))
    ])
    error_message = "each auth_callback_urls entry must be https, or http on localhost — Cognito rejects plain http anywhere else, and a redirect URI is where the authorization code lands."
  }
}

variable "auth_logout_urls" {
  type        = list(string)
  default     = ["http://localhost:5180/login"]
  description = "URLs Cognito may redirect to after a logout. Signing out has to end somewhere the user can sign in again, so this is normally the console's login page."

  validation {
    condition = alltrue([
      for url in var.auth_logout_urls :
      can(regex("^https://", url)) || can(regex("^http://localhost(:[0-9]+)?/", url))
    ])
    error_message = "each auth_logout_urls entry must be https, or http on localhost."
  }
}
