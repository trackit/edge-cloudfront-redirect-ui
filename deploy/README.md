# Deploying an environment from CI

`DEPLOY.md` at the repo root is the by-hand path: three stacks, applied in order,
each one's outputs feeding the next. This directory is that same deploy with a
runner behind it. No new deployment design — remote state, a role, and a name set
that cannot collide with anything else on the account.

```
backend.tf          empty S3 backend, copied into each stack before init
dev/*.tfvars        the dev environment's names and flags
```

`.github/workflows/deploy-dev.yml` applies all three stacks on every merge to
`dev`, and on demand.

## What has to exist before the first run

None of this can be created by the pipeline, because the pipeline needs it to
authenticate and to keep state. It is a one-time bootstrap.

**1. An S3 bucket for state.** Versioning on, encryption on, public access blocked.
Terraform is pinned to 1.15.6, which supports S3 native locking, so there is no
DynamoDB lock table to create — the workflow passes `use_lockfile=true`.

The bucket does not need to survive the weekly sweep. Being swept along with the
resources is consistent: state and reality disappear together and the next run
builds from empty. A _partial_ sweep is the bad case, not a total one.

**2. A GitHub OIDC provider and a deploy role** in the same account, the role
trusted on `repo:<org>/<repo>:environment:sandbox-dev`. **Not the `ref:` form** —
the deploy job names an `environment:`, and that changes GitHub's `sub` claim from
the branch to the environment. A trust policy written against
`ref:refs/heads/dev` looks right and never matches. Restricting which branches may
deploy is then the environment's own "deployment branches" setting, not the trust
policy. Beyond the obvious S3, DynamoDB,
API Gateway, Lambda and CloudFront permissions it needs `iam:CreateRole`,
`iam:PutRolePolicy` and `iam:PassRole`; `lambda:EnableReplication` and
`iam:CreateServiceLinkedRole` for the Lambda@Edge replicator; and
`cloudfront:CreateFunction` and `cloudfront:PublishFunction` for the basic-auth
gate.

> **This is the one piece that must outlive the sweep.** Everything else is rebuilt
> by the next run; the role is what the run authenticates with. If the sweeper does
> not honour an exclusion tag, the provider and role belong in a longer-lived
> account, assumed cross-account into the sandbox.

**3. A `sandbox-dev` environment** in the repository settings, holding:

|                       |                                           |
| --------------------- | ----------------------------------------- |
| `AWS_DEPLOY_ROLE_ARN` | variable — the role from step 2           |
| `AWS_REGION`          | variable — `us-east-1`                    |
| `STATE_BUCKET`        | variable — the bucket from step 1         |
| `BASIC_AUTH_PASSWORD` | **secret** — what the console prompts for |

Scoping them to the environment rather than the repository is what stops a
workflow on another branch from assuming the role.

## What the workflow does

1. Calls `ci.yml`. A push to `dev` does not run CI on its own, so without this the
   deploy would be the first thing to see a broken merge — after it had started
   changing infrastructure.
2. Applies `examples/infra`, then `console/api/infra`, then `console/ui/infra`,
   copying `backend.tf` in and pointing each at its own state key.
3. Threads `table_arn` into stack 2 and `api_endpoint` into stack 3 as `TF_VAR_*`.
   These are not in the tfvars because they do not exist until the stack before
   them has applied.
4. Seeds the rules table, so a fresh environment is not an empty one.
5. Writes the console URL, the demo site, the distribution id, the table name and
   its region into the job summary.

That last step is not a nicety. The console's connect screen is per-browser
`localStorage`, so everyone who opens the URL types those values in by hand.

## Things that will bite

- **The CloudFront domain is new after every sweep.** Copy it from the job summary;
  never paste it anywhere permanent.
- **`*.tfvars` is gitignored**, with an exception for `deploy/*/*.tfvars`. A new
  environment's files go in a subdirectory here or they will not commit, and
  nothing will tell you.
- **`backend.tf` must not be renamed to anything matching `*_override.tf`** —
  `.gitignore` swallows that pattern, and it would vanish from the checkout the
  workflow copies it from.
- **The first run is 30-40 minutes**, because two of the three stacks create
  CloudFront distributions. Later runs are 10-20, and any change to the edge
  function republishes a version and triggers another distribution deploy.
