# examples/infra — one-command data plane (ER-104)

A single `terraform apply` stands up the whole data plane — DynamoDB table,
Lambda@Edge, and a CloudFront distribution with the function attached — so you
can prove a hand-written rule is served at the edge, then tear it all down.

```
DynamoDB (rules)  ◄─── you insert a rule here (steps 2 and 4)
      ▲  Query(pk = viewer's hostname, begins_with(sk))
      │
CloudFront ──(viewer-request)──► L@E redirect (301/302)
           └─(origin-request)──► L@E rewrite ──► S3 placeholder origin
```

## Prerequisites

- An AWS account and credentials with permission to create DynamoDB, Lambda,
  IAM, S3, and CloudFront resources. **No pre-existing resources are required.**
- Terraform **≥ 1.7**.
- **Node.js + npm** on this machine — the edge module builds the handler with
  esbuild during `apply` (it runs `npm ci` at the repo root).
- The AWS CLI (for inserting the sample rule).

## 1. Deploy

```bash
cd examples/infra
terraform init
terraform apply
```

CloudFront takes **~5–15 minutes** to deploy and replicate the Lambda to the
edge. When `apply` finishes, note the outputs:

```bash
terraform output cloudfront_domain_name
terraform output -raw sample_put_item_command
```

> Deploying the console against this data plane as well? Follow
> [`DEPLOY.md`](../../DEPLOY.md) instead — it covers all three stacks in order, and
> `./seed-demo.sh` writes a host and three rules in one go rather than the single
> rule below.

## 2. Insert a sample rule (manually)

The edge keys rules on the hostname the viewer asked for. When you curl the
default `*.cloudfront.net` domain, that domain **is** the host — so the rule's
`pk` is the distribution's own domain. The `sample_put_item_command` output
already has it filled in:

```bash
eval "$(terraform output -raw sample_put_item_command)"
```

That inserts a redirect: `GET /old-landing` → `301 https://example.com/new-landing`.

<details>
<summary>Prefer a file?</summary>

Edit `sample-rule.json`, replacing `REPLACE_WITH_CLOUDFRONT_DOMAIN` with the
`cloudfront_domain_name` output, then:

```bash
aws dynamodb put-item --region "$(terraform output -raw table_region 2>/dev/null || echo us-east-1)" \
  --table-name "$(terraform output -raw table_name)" \
  --item file://sample-rule.json
```

</details>

## 3. See the redirect

```bash
eval "$(terraform output -raw test_redirect_command)"
# → HTTP/2 301
#   location: https://example.com/new-landing
```

Rules propagate within **~1 minute** (the edge cache TTL). If you still see the
origin's page, wait a moment and retry.

## 4. See a rewrite (worth doing on purpose)

A redirect only proves the viewer-request half. A rewrite is evaluated at
origin-request, after CloudFront has replaced the `Host` header with the origin's
domain, so it only matches if viewer-request carried the viewer's hostname across
(see [infra/lambda](../../infra/lambda/README.md#the-host-a-rule-is-keyed-on)).
This is the check that proves that mechanism end to end on a real distribution.

The placeholder origin serves three pages — `index.html`, `pricing.html` and
`plans.html` — so a rewrite has somewhere visibly different to land:

```bash
# Before: nothing at that key, so S3 answers 404.
eval "$(terraform output -raw test_rewrite_command)"

eval "$(terraform output -raw sample_rewrite_put_item_command)"

# After (allow for the edge cache): 200, and the Pricing page.
eval "$(terraform output -raw test_rewrite_command)"
```

Both associations must be attached for this to pass — which this example does. If
it still 404s after the cache TTL, check CloudWatch in the region you curled
from: reaching origin-request with no stamped hostname is logged.

To watch a rule **change** being served rather than a rule existing, repoint the
same rule and curl the same path again — the URL never changes, the page does:

```bash
eval "$(terraform output -raw repoint_rewrite_put_item_command)"
eval "$(terraform output -raw test_rewrite_command)"   # → the Plans page
```

Rule changes take up to the edge cache TTL to appear, one minute by default. When
you are showing this to someone, deploy with a shorter one:

```bash
terraform apply -var 'cache_ttl_ms=10000'
```

That is baked into the bundle at package time, so changing it republishes the
function and the distribution redeploys (~5–15 min). Set it before the demo, not
during it.

> Two behaviours cannot be seen against this S3 origin, since nothing echoes the
> request back: `X-EdgeRoute-Viewer-Host` being removed before the request leaves
> for the origin, and `forwardSettings.useIncomingQueryString: false` dropping the
> query string. Both are covered by unit tests; observing them live needs an
> origin that echoes its request.

## 5. Tear down

```bash
terraform destroy
```

> **Lambda@Edge replicas:** CloudFront keeps edge replicas of the function for
> **~15 minutes to an hour** after the distribution stops using it. The first
> `destroy` removes the distribution and other resources but may **fail deleting
> the Lambda** with a replica error. That is expected — wait, then run
> `terraform destroy` again to remove the function.

## Using your own origin

By default the example creates a private S3 bucket (OAC-locked, `force_destroy`)
as the origin. To put the distribution in front of an existing origin instead:

```bash
terraform apply -var 'origin_domain_name=my-app.example.com'
```

No placeholder bucket is created; the distribution uses a custom (HTTPS) origin.

## Cost note

DynamoDB (on-demand) and Lambda@Edge cost effectively nothing at rest.
CloudFront has no fixed cost. Destroy when done to avoid lingering charges.
