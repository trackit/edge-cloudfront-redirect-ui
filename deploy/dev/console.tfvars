# console/ui/infra — the dev environment's console.
#
# Three values are missing on purpose and come from the workflow instead, because
# none of them exists until stack 2 has applied:
#
#   api_endpoint       TF_VAR_api_endpoint
#   cognito_domain     TF_VAR_cognito_domain
#   cognito_client_id  TF_VAR_cognito_client_id
#
# None is a secret — the client id travels in every authorize URL — they simply
# change whenever the control plane is rebuilt.

name = "edgeroute-dev-console"

npm_install_command = ""

tags = {
  project = "edgeroute"
  env     = "dev"
  managed = "github-actions"
}
