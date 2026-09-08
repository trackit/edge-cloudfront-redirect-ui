# console/ui/infra — hosting for the console

Serves the built console SPA and the console API from **one** CloudFront
distribution. Who may use it is Cognito's answer, not this module's — see
`console/api/infra`.

```
                         ┌─ /api/*  ──► API Gateway (console/api/infra)
viewer ──► CloudFront ───┤            (prefix stripped by the gate function)
           (gate fn)     └─ /*      ──► S3 bucket (private, OAC) — the SPA
```

## Why one distribution

The console calls the API at a relative `/api`, so the browser sees one origin and
no CORS is involved — which matters, because the API sends no CORS headers at all.
Splitting them across two domains means adding CORS to the API **and** leaving the
API reachable without the auth prompt, since the prompt only covers what arrives
through CloudFront.

## The gate function

One CloudFront Function on viewer-request, attached to both behaviors.
CloudFront allows only one viewer-request function per behavior, so it does both
jobs: stripping the `/api` prefix (the API serves `/health`, not `/api/health`),
and returning `index.html` for client-side routes.

The SPA fallback is done here rather than with `custom_error_response`, the usual
recipe. Those are distribution-wide, so the API's own 404s — an unknown host or
rule — would come back as `index.html` with status 200, and the console would
report them as malformed JSON.

Its logic is covered by
[`console/ui/test/cloudfront-gate.test.ts`](../test/cloudfront-gate.test.ts),
which reads `gate.js` and runs it. Whether CloudFront _accepts_ the file is only
provable on deploy — there is no local runtime.

### There used to be a basic-auth prompt here

It was a stopgap for the window before login existed, and it is gone. It only
ever stood in front of the bundle and the login page — neither holds a secret,
and the client id and Cognito domain baked into the bundle are public by design.
It could not stand in front of `/api` at all, because the console's bearer token
needs the header the credential used. Its password was also readable by anyone
with `cloudfront:GetFunction`, so it protected little and cost a second prompt in
front of the real one.

## Nothing is cached

Both behaviors use `Managed-CachingDisabled`: the SPA so a redeploy is visible
without an invalidation, the API because its responses are per-request state. That
is a deliberate demo trade-off — a production console would cache the hashed assets
under `/assets/` and invalidate `index.html`.

## Usage

```bash
cp sandbox.tfvars.example sandbox.tfvars   # then fill it in
terraform init
terraform apply -var-file=sandbox.tfvars
terraform output console_url
```

`sandbox.tfvars` rather than `terraform.tfvars` because Terraform auto-loads the
latter, including during `terraform test`, where it would override the defaults the
suite asserts on.

The distribution takes **5–15 minutes** to deploy, so the URL will not answer
immediately. `console/api/infra` has to be applied first — its `api_endpoint`,
`cognito_domain` and `user_pool_client_id` outputs are inputs here.

Then apply `console/api/infra` a **second** time, with this stack's `console_url`
in its `auth_callback_urls`. Cognito only redirects back to a URL it already
knows, and that URL does not exist until the distribution does. The second apply
changes the app client alone — no distribution deploy, so it is quick.

To check the API is reachable through the distribution:

```bash
curl -i "$(terraform output -raw console_url)/api/health"
# → {"status":"ok"}
```

`/health` is public at the gateway, so that answers without a token. Every other
route is behind the JWT authorizer.

## Build and upload

A single `null_resource` builds the SPA and runs `aws s3 sync --delete`, triggered
on the sources rather than on the build output.

The declarative alternative — `aws_s3_object` with `for_each = fileset(dist)` —
does not work: `fileset` is evaluated during plan, so on a fresh clone (no `dist/`)
the plan contains zero objects and the first apply uploads nothing, silently.
`aws s3 sync` also sets each object's `Content-Type` from its extension, which a
`for_each` would need a MIME map for.

Consequences worth knowing:

- **The AWS CLI must be installed** on the machine running apply.
- **Object-level drift is invisible.** Deleting a file straight out of the bucket
  is only repaired by the next source change, or `terraform taint`.
- The bucket is `force_destroy = true`, so a destroy does not need it emptied
  first. It holds build output only.

## Inputs

| Name                  | Type   | Default             | Description                                               |
| --------------------- | ------ | ------------------- | --------------------------------------------------------- |
| `api_endpoint`        | string | —                   | `console/api/infra`'s output. Host only, no path.         |
| `cognito_domain`      | string | —                   | Same stack's output. Baked in as `VITE_COGNITO_DOMAIN`.   |
| `cognito_client_id`   | string | —                   | Same stack's `user_pool_client_id`. Not a secret.         |
| `name`                | string | `edgeroute-console` | Prefixes the bucket, the function and the tags.           |
| `price_class`         | string | `PriceClass_100`    | US/EU edges.                                              |
| `ui_source_dir`       | string | `..`                | The `console/ui` workspace.                               |
| `monorepo_root`       | string | `../../..`          | Where the dependency install runs.                        |
| `npm_install_command` | string | `npm ci`            | Set to `npm install` to keep your working `node_modules`. |
| `tags`                | map    | `{}`                | Applied to every resource.                                |

## Outputs

| Name                       | What                                             |
| -------------------------- | ------------------------------------------------ |
| `console_url`              | Where the console is served.                     |
| `distribution_id`          | For `get-distribution` or a manual invalidation. |
| `distribution_domain_name` | The domain without the scheme.                   |
| `bucket_name`              | Bucket the SPA is synced to.                     |
| `function_arn`             | The gate function.                               |
| `api_health_command`       | Ready-made curl for the check above.             |

## Known gap

The API Gateway URL stays reachable directly, so the auth prompt is not a
perimeter — it covers traffic through CloudFront only. Accepted for the MVP demo,
where no auth was planned at all. Closing it means having CloudFront send a secret
header on the `/api/*` origin and the API refuse requests without it.
