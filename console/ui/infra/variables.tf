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

variable "cognito_domain" {
  type        = string
  description = "Hosted UI the console signs in through — the `cognito_domain` output of console/api/infra. Baked into the bundle as VITE_COGNITO_DOMAIN."

  validation {
    # Same shape as api_endpoint, and for a related reason: the SPA appends
    # /oauth2/authorize to this, so a value carrying a path builds a URL that
    # fails at Cognito rather than here.
    condition     = can(regex("^https://[a-z0-9.-]+/?$", var.cognito_domain))
    error_message = "cognito_domain must be https:// followed by a host and nothing else, e.g. https://edgeroute-dev.auth.us-east-1.amazoncognito.com."
  }
}

variable "cognito_client_id" {
  type        = string
  description = "App client the console presents as — the `user_pool_client_id` output of console/api/infra. Baked into the bundle as VITE_COGNITO_CLIENT_ID. Not a secret: it is in every authorize URL, and the secret it pairs with never leaves the API's Lambda."

  validation {
    condition     = can(regex("^[a-z0-9]{1,128}$", var.cognito_client_id))
    error_message = "cognito_client_id must be a Cognito app client id: 1-128 lowercase letters and digits."
  }
}

# Neither of the two above has a default, and that is deliberate. `authConfig()`
# throws when either is missing, so the SPA would build clean and then fail on
# load; a placeholder would be worse still, sending the browser to a URL that
# fails at Cognito where the cause is invisible. Failing the plan names the
# variable instead.

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
