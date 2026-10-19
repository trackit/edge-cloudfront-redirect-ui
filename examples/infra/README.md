# examples/infra — one-command data plane (CF-10)

A single `terraform apply` stands up the whole data plane — DynamoDB table,
Lambda@Edge, and a CloudFront distribution with the function attached — so you
can prove a hand-written rule is served at the edge, then tear it all down.

```
DynamoDB (rules)  ◄─── you insert a rule here (steps 2 and 4)
      ▲  Query(pk = viewer's hostname, begins_with(sk))
      │
CloudFront ──(viewer-request)──► L@E redirect (301/302)
           └─(origin-request)──► L@E rewrite ──► S3 placeholder origin
                                              ├──► second S3 bucket   (a rule can switch to it)
                                              └──► echo function URL  (a rule can switch to it)
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
# Before: nothing at that key, so S3 answers 403.
eval "$(terraform output -raw test_rewrite_command)"

eval "$(terraform output -raw sample_rewrite_put_item_command)"

# After (allow for the edge cache): 200, and the Pricing page.
eval "$(terraform output -raw test_rewrite_command)"
```

Both associations must be attached for this to pass — which this example does. If
it still 403s after the cache TTL, check CloudWatch in the region you curled
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

> Two behaviours cannot be seen against this S3 origin, since it does not echo the
> request back: `X-EdgeRoute-Viewer-Host` being removed before the request leaves
> for the origin, and `forwardSettings.useIncomingQueryString: false` dropping the
> query string. The echo origin in the next section shows both.

## 5. See a rewrite switch origin

A rewrite can also send the request to a different origin, which the console
calls **Change origin**: an S3 bucket or a custom origin. The example creates one
of each to switch to, and `./seed-demo.sh` writes a rule for both:

| Path               | Origin                                            | Shows                                                   |
| ------------------ | ------------------------------------------------- | ------------------------------------------------------- |
| `/s3-rewrite.html` | a second private bucket (`s3_rewrite_origin_*`)   | its own page; the distribution's bucket has no such key |
| `/echo`            | a Lambda function URL (`echo_origin_domain_name`) | the request it received, as JSON                        |

```bash
eval "$(terraform output -raw test_s3_rewrite_command)"      # 200, "S3 rewrite"
eval "$(terraform output -raw test_custom_rewrite_command)"  # 200, the echo
```

Without the rules, both answer 403 from the distribution's own bucket.

To build the rules in the console instead, take the origin from the outputs:

- **S3 origin**: bucket domain `s3_rewrite_origin_domain_name`, auth method
  `origin-access-identity`, region `s3_rewrite_origin_region`.
- **Custom origin**: domain `echo_origin_domain_name`, HTTPS, port 443.

What the echo shows:

- `path` is the rewritten path, and `headers.host` is the echo's own domain:
  the origin got its own Host, not the viewer's.
- `x-edgeroute-viewer-host` is absent: the edge removed it before the request
  left.
- `query` is what the viewer sent, until the rule's **Use incoming query
  string** is turned off. Then it is empty.

> **Why the example uses an origin access identity.** AWS now recommends origin
> access control (OAC) over an OAI, but OAC does not sign a request whose origin
> Lambda@Edge changed. An S3 origin set by the edge with `origin-access-identity`
> has to use the same OAI as the origin it replaced, and the edge cannot use an
> OAI at all when the request starts at a custom origin. So both buckets trust the
> distribution's one OAI, and with `origin_domain_name` set there is no second
> bucket. The same applies to any distribution whose rules switch to a private
> bucket.

## Smoke-test country conditions

`./smoke-geo.sh` checks the geolocation feature against this distribution, from
the machine you run it on. Tell it where that machine is — CloudFront places it
by IP, so a VPN changes the answer:

```bash
MY_COUNTRY=FR ./smoke-geo.sh
```

It writes a few rules under `/geo-smoke/`, waits for the rule cache, and checks
that a redirect for your country fires, that an exclusion of it does not, that a
classic redirect answers before a geo one, and that claiming another country in
a `CloudFront-Viewer-Country` request header changes nothing. The rules are
deleted on exit (`KEEP=1` keeps them). It exits non-zero on any failure, and
says what usually causes each one.

## 6. Tear down

```bash
terraform destroy
```

> **Lambda@Edge replicas:** CloudFront keeps edge replicas of the function for
> **~15 minutes to an hour** after the distribution stops using it. The first
> `destroy` removes the distribution and other resources but may **fail deleting
> the Lambda** with a replica error. That is expected — wait, then run
> `terraform destroy` again to remove the function.

## Using your own origin

By default the example creates a private S3 bucket (OAI-locked, `force_destroy`)
as the origin. To put the distribution in front of an existing origin instead:

```bash
terraform apply -var 'origin_domain_name=my-app.example.com'
```

No placeholder bucket is created; the distribution uses a custom (HTTPS) origin.
Nor is the second bucket, since the edge cannot switch from a custom origin to a
bucket behind an OAI. The echo origin is still created.

## Cost note

DynamoDB (on-demand) and Lambda@Edge cost effectively nothing at rest.
CloudFront has no fixed cost. Destroy when done to avoid lingering charges.
