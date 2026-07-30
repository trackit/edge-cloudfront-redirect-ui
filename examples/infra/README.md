# examples/infra — one-command data plane (ER-104)

A single `terraform apply` stands up the whole data plane — DynamoDB table,
Lambda@Edge, and a CloudFront distribution with the function attached — so you
can prove a hand-written rule is served at the edge, then tear it all down.

```
DynamoDB (rules)  ◄─── you insert a rule here (step 4)
      ▲  Query(pk = Host, begins_with(sk))
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

## 2. Insert a sample rule (manually)

The edge keys rules on the request's `Host` header. When you curl the default
`*.cloudfront.net` domain, that domain **is** the host — so the rule's `pk` is
the distribution's own domain. The `sample_put_item_command` output already has
it filled in:

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

> **Rewrites too:** insert a `frMatchRule` (see
> [`shared/examples/rewrite-example.json`](../../shared/examples/rewrite-example.json),
> `sk = REWRITE#…`) and the origin-request association rewrites the path and/or
> swaps `request.origin`.

## 4. Tear down

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
