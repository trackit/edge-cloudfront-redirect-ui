# console/api/infra — the dev environment's control plane.
#
# `target_table_arns` is deliberately absent: it is the data plane's `table_arn`,
# which only exists after stack 1 applies, so the workflow passes it as
# TF_VAR_target_table_arns. Setting it here would pin dev to a table it may not own.
#
# `targets_table_name` is absent too — it defaults to <function_name>-targets, so
# naming the function is enough to keep the registry table distinct as well.

function_name = "edgeroute-dev-console-api"

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
