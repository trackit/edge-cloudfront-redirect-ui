# console/api/infra — the dev environment's control plane.
#
# `target_table_arns` is deliberately absent: it is the data plane's `table_arn`,
# which only exists after stack 1 applies, so the workflow passes it as
# TF_VAR_target_table_arns. Setting it here would pin dev to a table it may not own.
#
# `targets_table_name` is absent too — it defaults to <function_name>-targets, so
# naming the function is enough to keep the registry table distinct as well.
#
# `auth_callback_urls` and `auth_logout_urls` are absent for the same reason as
# target_table_arns, one stack later: they need the console's CloudFront domain,
# which does not exist until stack 3 has applied. The workflow applies this stack
# a second time afterwards to set them.

function_name = "edgeroute-dev-console-api"

# The Cognito hosted UI lives at <prefix>.auth.<region>.amazoncognito.com, and
# that name is unique across every AWS account — not just this one. If an apply
# fails claiming the domain is taken, someone else has it and this value has to
# change; there is no way to check beforehand.
#
# A sweep deletes the domain along with the pool. AWS releases the name with it,
# but not always instantly, so a rebuild straight after a sweep can need a retry.
cognito_domain_prefix = "edgeroute-dev-console"

allowed_regions = ["us-east-1"]

# The registry is protected by default, which blocks `terraform destroy` and makes
# the weekly sweep fight the table. dev is rebuilt from CI, so there is nothing
# here worth protecting.
deletion_protection = false

# The workflow already ran `npm ci` at the repo root. Left at its default this
# shells out to a second full reinstall inside local-exec.
npm_install_command = ""

tags = {
  project = "edgeroute"
  env     = "dev"
  managed = "github-actions"
}
