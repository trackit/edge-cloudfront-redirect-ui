# Copied into each stack directory by the deploy workflow, immediately before
# `terraform init`, and never committed inside a stack.
#
# The reason it lives here rather than in the stacks: this repo is a pluggable
# module. A `backend "s3"` block committed inside examples/infra or console/*/infra
# would run for every consumer who clones it, and `terraform init` would ask them
# for a bucket they have no reason to own. It would also break the by-hand path in
# DEPLOY.md, which is the fallback when the pipeline cannot authenticate.
#
# Empty on purpose. Bucket, key and region are supplied by the workflow with
# `-backend-config`, which is what lets one file serve all three stacks.
#
# Do not rename this to anything matching *_override.tf — .gitignore swallows that
# pattern, and the file would vanish from the checkout the workflow copies it from.
terraform {
  backend "s3" {}
}
