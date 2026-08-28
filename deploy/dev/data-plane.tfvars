# examples/infra — the dev environment's data plane.
#
# Every name here is account-unique and fails the apply rather than adopting what
# is already there, so this file is what keeps the dev instance off any other
# instance's resources. Passed explicitly with -var-file; never auto-loaded.

table_name    = "edgeroute-dev-rules"
function_name = "edgeroute-dev-redirect-rules"

# Ten seconds instead of a minute, so a rule change is visible while someone is
# still looking at it. Baked into the function at package time — changing it later
# means republishing and another distribution deploy.
cache_ttl_ms = 10000

tags = {
  project = "edgeroute"
  env     = "dev"
  managed = "github-actions"
}
