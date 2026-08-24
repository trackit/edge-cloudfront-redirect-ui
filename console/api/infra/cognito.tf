# Authentication for the control plane (ER-205).
#
# The pool lives beside the API rather than in its own state because the JWT
# authorizer has to reference it, and a cross-state lookup to wire an authorizer
# to the pool it authorizes buys nothing. The cost is that destroying this state
# destroys the pool and its users; the seed script exists so recreating the demo
# accounts is one command rather than a console session.

# The hosted UI's URL is built from the region rather than hardcoded, so the same
# configuration works wherever this is applied.
data "aws_region" "current" {}

resource "aws_cognito_user_pool" "this" {
  name = var.function_name

  # Admin-created only. This is a control plane that can repoint production
  # traffic, so an open sign-up form is not a default anyone should have to
  # remember to turn off.
  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  password_policy {
    minimum_length                   = 12
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = true
    temporary_password_validity_days = 1
  }

  # Optional rather than off: MFA can be enabled per user without a pool-level
  # migration, and turning it on later for everyone is a one-line change here.
  mfa_configuration = "OPTIONAL"

  software_token_mfa_configuration {
    enabled = true
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  tags = var.tags
}

# Hosted UI. The console redirects here for the credential exchange rather than
# collecting passwords itself, which keeps password reset, the forced first-login
# change, lockout and MFA as pool configuration instead of screens we maintain.
resource "aws_cognito_user_pool_domain" "this" {
  domain       = var.cognito_domain_prefix
  user_pool_id = aws_cognito_user_pool.this.id
}

# A confidential client: the authorization code is exchanged by the API, not the
# browser, so the secret never reaches a place a viewer can read it. The refresh
# token comes back to the API and is set as an HttpOnly cookie, which is the
# reason this is not the public + PKCE client a pure SPA would use.
resource "aws_cognito_user_pool_client" "console" {
  name         = "${var.function_name}-console"
  user_pool_id = aws_cognito_user_pool.this.id

  generate_secret = true

  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = ["COGNITO"]

  callback_urls = var.auth_callback_urls
  logout_urls   = var.auth_logout_urls

  # An hour of access token, thirty days of refresh. The refresh token is the one
  # that lives in a cookie, so its lifetime is how long a browser stays signed in
  # without re-entering a password.
  access_token_validity  = 60
  id_token_validity      = 60
  refresh_token_validity = 30

  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }

  # Rotation is deliberately left off. Two console tabs refresh independently,
  # and with rotation on the slower one presents a token the faster one already
  # spent — which logs both out. See the single-flight note in the UI's auth
  # context; per-tab refresh is only safe while the token survives reuse.
  enable_token_revocation = true

  # ALLOW_USER_PASSWORD_AUTH is absent on purpose: nothing outside the hosted UI
  # should be able to trade a password for a token, and its absence is what makes
  # that true rather than a convention.
  explicit_auth_flows = [
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]

  prevent_user_existence_errors = "ENABLED"
}

# Roles as groups rather than a custom attribute: membership arrives in the
# `cognito:groups` claim with no mapping to maintain, and it can be changed
# without editing the user record.
resource "aws_cognito_user_group" "viewer" {
  name         = "viewer"
  user_pool_id = aws_cognito_user_pool.this.id
  description  = "Read-only. May list targets, hosts and rules."
}

resource "aws_cognito_user_group" "editor" {
  name         = "editor"
  user_pool_id = aws_cognito_user_pool.this.id
  description  = "Full CRUD on targets, hosts and rules."
}

# The gateway validates the signature, issuer and audience, and 401s anything
# that fails — so an unauthenticated request never reaches the Lambda. It cannot
# express viewer-versus-editor, because with one $default route there is nowhere
# to hang a per-method scope; the router does that and returns 403.
resource "aws_apigatewayv2_authorizer" "jwt" {
  api_id           = aws_apigatewayv2_api.this.id
  name             = "${var.function_name}-cognito"
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]

  jwt_configuration {
    audience = [aws_cognito_user_pool_client.console.id]
    issuer   = "https://${aws_cognito_user_pool.this.endpoint}"
  }
}

# Routes that must stay reachable without a token. A more specific route key wins
# over $default, so listing them here is what exempts them.
#
# The three /auth routes are the exchange itself: you call them to obtain a token,
# so requiring one would be circular. They are not unprotected — the session
# exchange needs a code Cognito only issues after a login, and refresh needs the
# HttpOnly cookie.
locals {
  public_routes = [
    "GET /health",
    "POST /auth/session",
    "POST /auth/refresh",
    "POST /auth/logout",
  ]
}

resource "aws_apigatewayv2_route" "public" {
  for_each = toset(local.public_routes)

  api_id             = aws_apigatewayv2_api.this.id
  route_key          = each.value
  target             = "integrations/${aws_apigatewayv2_integration.this.id}"
  authorization_type = "NONE"
}
