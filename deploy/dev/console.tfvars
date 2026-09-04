# console/ui/infra — the dev environment's console.
#
# Two values are missing on purpose and come from the workflow instead:
#
#   api_endpoint         TF_VAR_api_endpoint, from stack 2's output
#   basic_auth_password  TF_VAR_basic_auth_password, from the environment secret
#
# The password is rendered into the CloudFront Function's code and stored in
# state, so anyone with cloudfront:GetFunction can read it back. It is a gate, not
# a secret — but it still does not belong in a tracked file.

name = "edgeroute-dev-console"

basic_auth_username = "dev"

npm_install_command = ""

tags = {
  project = "edgeroute"
  env     = "dev"
  managed = "github-actions"
}
