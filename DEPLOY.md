# Deploying the whole thing to a sandbox account

Three stacks, applied in order. Each one's outputs are the next one's inputs, which
is the only reason the order matters.

```
1. Data plane      examples/infra      DynamoDB rules table + Lambda@Edge
                                       + a demo CloudFront distribution
2. Control plane   console/api/infra   API Gateway + Lambda + targets registry
3. Console         console/ui/infra    S3 + CloudFront + basic-auth gate,
                                       serving the SPA and /api/* together
```

Two of those create CloudFront distributions, so budget **5–15 minutes** each for
them to deploy. Total wall-clock for a first run is around 30–40 minutes, most of
it waiting.

## Before you start

- Terraform **≥ 1.7**, Node **20+**, npm, and the **AWS CLI** (the console's upload
  step shells out to `aws s3 sync`).
- Credentials for the sandbox account, and `AWS_PROFILE` pointing at them:

  ```bash
  aws sso login --profile <your-sandbox-profile>
  export AWS_PROFILE=<your-sandbox-profile>
  aws sts get-caller-identity          # confirm the account before applying
  ```

  Nothing in this repo pins an account or a profile, so whatever is in your
  environment is what gets deployed to. Check it.

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

Edit `sandbox.tfvars`: put the `table_arn` from step 1 into `target_table_arns`.
**This is the setting that is easy to miss** — it is empty by default, and empty
means the API can reach no rules table, so the console lists hosts and then fails
on every one of them with AccessDenied.

```bash
terraform init
terraform apply -var-file=sandbox.tfvars
terraform output api_endpoint    # → step 3
```

> The file is `sandbox.tfvars`, not `terraform.tfvars`, so it has to be passed
> explicitly. Terraform auto-loads `terraform.tfvars` everywhere — including
> `terraform test`, where it overrides the defaults the suite asserts on and fails
> two runs that have nothing to do with your change.

## 3. Console

```bash
cd ../../console/ui/infra
cp sandbox.tfvars.example sandbox.tfvars
```

Edit `sandbox.tfvars`: the `api_endpoint` from step 2, and the username and
password the console will prompt for. The credential ends up in the CloudFront
Function's code and in Terraform state, so use a throwaway one — see
[the module's README](console/ui/infra/README.md#the-credential-is-not-a-secret).

```bash
terraform init
terraform apply -var-file=sandbox.tfvars
terraform output console_url
```

## 4. Seed the demo data

```bash
cd ../../examples/infra
./seed-demo.sh
```

Writes one host — the demo distribution's own domain — plus three rules: a 301, a
302, and a rewrite. Safe to re-run; it resets the demo to a known state, including
anything edited in the console.

## 5. Check it works

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
curl -i -u '<username>:<password>' "$(terraform output -raw console_url)/api/health"
# → {"status":"ok"}
```

**The console, end to end.** Open `console_url`, enter the credential at the
browser prompt, then on the connect screen enter:

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

## 6. Tear down

Reverse order:

```bash
cd console/ui/infra        && terraform destroy -var-file=sandbox.tfvars
cd ../../console/api/infra && terraform destroy -var-file=sandbox.tfvars
cd ../../examples/infra    && terraform destroy
```

The two console stacks need their var file on destroy as well — `api_endpoint` and
the credential have no defaults, so Terraform stops and asks for them otherwise.

Two things will interrupt this:

- **The targets registry table** has deletion protection on unless you set
  `deletion_protection = false` (`sandbox.tfvars.example` does). If it is on, flip it,
  `terraform apply`, then destroy.
- **Lambda@Edge replicas** live on for 15 minutes to an hour after the
  distribution stops using them, so the first `destroy` of the data plane usually
  fails to delete the function. That is expected — wait, then destroy again.

## Cost

DynamoDB on-demand, Lambda@Edge and CloudFront have no fixed cost, so an idle
deployment is effectively free. Both distributions are `PriceClass_100`. Destroy
when you are done anyway — there is no reason to leave a console with a basic-auth
password on the internet.

## Known gaps

These are accepted for the MVP demo, not oversights:

- **The API Gateway URL is reachable directly.** The basic-auth prompt only covers
  requests arriving through CloudFront, so anyone with the API's URL can read and
  write rules. Real auth is post-MVP.
- **The console's connect screen is per browser.** No server-side profile, so
  there is nothing to pre-configure for other people.
- **Nothing is cached** on the console distribution, deliberately, so a redeploy
  needs no invalidation.
