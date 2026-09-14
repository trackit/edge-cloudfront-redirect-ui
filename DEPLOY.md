# Deploying the whole thing to a sandbox account

Three stacks, applied in order. Each one's outputs are the next one's inputs, which
is the only reason the order matters.

```
1. Data plane      examples/infra      DynamoDB rules table + Lambda@Edge
                                       + a demo CloudFront distribution
2. Control plane   console/api/infra   API Gateway + Lambda + targets registry
3. Console         console/ui/infra    S3 + CloudFront + gate function,
                                       serving the SPA and /api/* together
```

Two of those create CloudFront distributions, so budget **5–15 minutes** each for
them to deploy. Total wall-clock for a first run is around 30–40 minutes, most of
it waiting.

## Before you start

- Terraform **≥ 1.7**, Node **20+**, npm, and the **AWS CLI** (the console's upload
  step shells out to `aws s3 sync`).
- Credentials for the sandbox account, and **both** `AWS_PROFILE` and
  `AWS_REGION` exported:

  ```bash
  aws sso login --profile <your-sandbox-profile>
  export AWS_PROFILE=<your-sandbox-profile>
  export AWS_REGION=us-east-1
  aws sts get-caller-identity          # confirm the account before applying
  ```

  Nothing in this repo pins an account or a profile, so whatever is in your
  environment is what gets deployed to. Check it.

  `AWS_REGION` is not optional, and going without it fails in a confusing place.
  The two console stacks declare no `provider "aws"` block at all — they are meant
  to be consumed as modules, so the region comes from whoever calls them.
  `examples/infra` does have its own provider with a `region` variable, so step 1
  succeeds without the export and **step 2 is where it stops**, with
  `invalid AWS Region:` and nothing after the colon. A profile that lives only in
  `~/.aws/credentials`, with no matching `[profile …]` entry in `~/.aws/config`,
  carries no region either — so "it worked for the data plane" is not evidence
  that the region is set.

## 1. Data plane

```bash
cd examples/infra
terraform init
terraform apply -var 'cache_ttl_ms=10000'
```

`cache_ttl_ms=10000` shortens the edge's rule cache from a minute to ten seconds,
so a rule change shows up while someone is still watching. It is baked into the
function at package time, so it cannot be changed later without republishing and
another distribution deploy — set it now, not during a demo.

Keep these:

```bash
terraform output cloudfront_domain_name       # the demo site
terraform output cloudfront_distribution_id   # needed on the console's connect screen
terraform output table_name
terraform output table_arn                    # → step 2
```

## 2. Control plane

```bash
cd ../../console/api/infra
cp sandbox.tfvars.example sandbox.tfvars
```

Edit `sandbox.tfvars`. Two settings need a value from you:

- **`target_table_arns`** — the `table_arn` from step 1. **This is the one that is
  easy to miss.** It is empty by default, and empty means the API can reach no
  rules table at all, so the console lists hosts and then fails on every one of
  them with AccessDenied.
- **`cognito_domain_prefix`** — the hosted UI's name, giving
  `<prefix>.auth.<region>.amazoncognito.com`. It has no default because that name
  is unique across **every** AWS account, not just yours: a collision fails the
  apply, there is no way to check beforehand, and the only fix is a different
  value.

```bash
terraform init
terraform apply -var-file=sandbox.tfvars
terraform output api_endpoint          # → step 3
terraform output cognito_domain        # → step 3
terraform output user_pool_client_id   # → step 3
```

This stack creates the Cognito user pool, its hosted UI domain, the app client
the console signs in through, and the JWT authorizer that refuses an
unauthenticated request at the gateway.

> The file is `sandbox.tfvars`, not `terraform.tfvars`, so it has to be passed
> explicitly. Terraform auto-loads `terraform.tfvars` everywhere — including
> `terraform test`, where it overrides the defaults the suite asserts on and fails
> two runs that have nothing to do with your change.

## 3. Console

```bash
cd ../../console/ui/infra
cp sandbox.tfvars.example sandbox.tfvars
```

Edit `sandbox.tfvars` with three values from step 2: `api_endpoint`,
`cognito_domain` and `cognito_client_id`. All three are baked into the SPA at
build time, and none is a secret — the client id travels in every authorize URL,
and the client secret it pairs with never leaves the API's Lambda.

```bash
terraform init
terraform apply -var-file=sandbox.tfvars
terraform output console_url
```

The console is not usable yet — Cognito has never heard of this domain, so a
sign-in would be refused at the redirect. Step 4 is what fixes that.

## 4. Point Cognito at the console

Cognito only redirects back to a URL it has been told about, and the console's
domain did not exist until the apply above. That makes the callback list the one
input that cannot be threaded forward in a single pass, so stack 2 is applied a
second time now that the domain exists:

```bash
cd ../../console/api/infra
console_url=$(terraform -chdir=../../ui/infra output -raw console_url)

terraform apply -var-file=sandbox.tfvars \
  -var "auth_callback_urls=[\"$console_url/auth/callback\",\"http://localhost:5180/auth/callback\"]" \
  -var "auth_logout_urls=[\"$console_url/login\",\"http://localhost:5180/login\"]"
```

Only the app client changes, so this takes a minute rather than another
distribution deploy. Keeping the `localhost` entries lets `npm run dev` sign in
against the same pool instead of needing one of its own.

Skip this and the failure looks like a broken console rather than a missing
setting: sign-in reaches Cognito and comes back refused, with `redirect_mismatch`.

## 5. Create the sign-in accounts

```bash
./seed-users.sh
```

Two accounts, one per role — `viewer@example.com` and `editor@example.com` — with
passwords generated per run and printed once, at the end. Nothing is written to
disk, and no password is committed anywhere: a known credential for a control
plane that can repoint live traffic would be a real hole, demo or not.

Safe to re-run. An account that already exists keeps its password and is only
re-added to its group, so re-running repairs group membership without locking
anyone out of a session they are already using.

The two roles **are** the demo: sign in as the viewer and the console's write
controls are dead; sign in as the editor and they are not.

## 6. Seed the demo data

```bash
cd ../../examples/infra
./seed-demo.sh
```

Writes one host — the demo distribution's own domain — plus three rules: a 301, a
302, and a rewrite. Safe to re-run; it resets the demo to a known state, including
anything edited in the console.

## 7. Check it works

**The data plane, straight from the edge:**

```bash
curl -i "https://$(terraform output -raw cloudfront_domain_name)/old-landing"   # 301
curl -i "https://$(terraform output -raw cloudfront_domain_name)/promo"         # 302
curl -i "https://$(terraform output -raw cloudfront_domain_name)/old-pricing"   # 200, Pricing page
```

The third one matters most. Rewrites are evaluated at origin-request, where the
`Host` header is the origin's domain, so it only matches because viewer-request
carried the viewer's hostname across. If it 404s, that mechanism is broken — check
CloudWatch in the region you curled from, where a missing hostname stamp is logged.

**The API through the console's distribution:**

```bash
cd ../../console/ui/infra
curl -i "$(terraform output -raw console_url)/api/health"
# → {"status":"ok"}
```

That answers without a token because `/health` is public at the gateway. Every
other route is behind the JWT authorizer — including on the API's own
`execute-api` URL, which is reachable from the internet directly. CloudFront is a
convenience in front of the API, never a control.

**The console, end to end.** Open `console_url`, sign in as the editor account
from step 5, then on the connect screen enter:

| Field           | Value                                    |
| --------------- | ---------------------------------------- |
| Distribution ID | `cloudfront_distribution_id` from step 1 |
| Table name      | `table_name` from step 1                 |
| Region          | the region you deployed the table in     |

The connect screen appears once per browser — it is stored in `localStorage`, not
on the server, so every person who opens the console fills it in. Have those three
values to hand.

You should then see the seeded host with its three rules. To watch a change go
live: open the rewrite rule, change its path from `/pricing.html` to
`/plans.html`, save, wait out the cache TTL, and curl `/old-pricing` again — same
URL, different page.

> One snag worth knowing before doing this in front of people: the rewrite editor
> opens on "custom origin", so a path-only rewrite needs the origin selector
> switched to "none" first. Otherwise it asks for an origin domain and refuses to
> save.

## 8. Tear down

Reverse order:

```bash
cd console/ui/infra        && terraform destroy -var-file=sandbox.tfvars
cd ../../console/api/infra && terraform destroy -var-file=sandbox.tfvars
cd ../../examples/infra    && terraform destroy
```

The two console stacks need their var file on destroy as well — `api_endpoint`,
the Cognito values and `cognito_domain_prefix` have no defaults, so Terraform
stops and asks for them otherwise.

Three things will interrupt this:

- **The targets registry table** has deletion protection on unless you set
  `deletion_protection = false` (`sandbox.tfvars.example` does). If it is on, flip it,
  `terraform apply`, then destroy.
- **Lambda@Edge replicas** live on for 15 minutes to an hour after the
  distribution stops using them, so the first `destroy` of the data plane usually
  fails to delete the function. That is expected — wait, then destroy again.
- **The Cognito domain name** is released when the pool goes, but not always
  immediately. Redeploying straight afterwards with the same
  `cognito_domain_prefix` can fail as taken; wait, or pick another.

## Cost

DynamoDB on-demand, Lambda@Edge and CloudFront have no fixed cost, so an idle
deployment is effectively free. Both distributions are `PriceClass_100`. Destroy
when you are done anyway.

## Known gaps

These are accepted for the MVP demo, not oversights:

- **Accounts live in the pool.** `identity_provider` is null by default, so these
  are Cognito's own username-and-password accounts rather than your SSO. Setting
  it adds a button to the hosted UI and changes no console code — it is left off
  because this is a tool other people deploy into their own accounts, and the
  provider is theirs to choose.
- **The console's connect screen is per browser.** No server-side profile, so
  there is nothing to pre-configure for other people.
- **Nothing is cached** on the console distribution, deliberately, so a redeploy
  needs no invalidation.
