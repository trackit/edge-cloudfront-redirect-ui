# examples/infra — the dev environment's data plane.
#
# Every name here is account-unique and fails the apply rather than adopting what
# is already there, so this file is what keeps the dev instance off any other
# instance's resources. Passed explicitly with -var-file; never auto-loaded.

table_name    = "edgeroute-dev-rules"
function_name = "edgeroute-dev-redirect-rules"

# A minute, which is the module's default and the figure the README quotes. Stated
# rather than left implicit because this is the environment a demo runs against,
# and the propagation delay someone is shown should be the one the product has.
#
# It was ten seconds for a while, so a rule change landed while someone was still
# looking at it. That made the demo flattering and the documentation wrong.
#
# Baked into the function at package time, so changing it means republishing and
# another distribution deploy — not something to do mid-demo.
cache_ttl_ms = 60000

tags = {
  project = "edgeroute"
  env     = "dev"
  managed = "github-actions"
}
