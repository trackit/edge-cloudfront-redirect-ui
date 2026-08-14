# console/ui/infra — hosting for the console

Serves the built console SPA and the console API from **one** CloudFront
distribution, behind a basic-auth prompt.

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
CloudFront allows only one viewer-request function per behavior, so it does all
three jobs: basic auth, stripping the `/api` prefix (the API serves `/health`, not
`/api/health`), and returning `index.html` for client-side routes.

The SPA fallback is done here rather than with `custom_error_response`, the usual
recipe. Those are distribution-wide, so the API's own 404s — an unknown host or
rule — would come back as `index.html` with status 200, and the console would
report them as malformed JSON.

Its logic is covered by
[`console/ui/test/cloudfront-gate.test.ts`](../test/cloudfront-gate.test.ts),
which renders this module's template and runs it. Whether CloudFront _accepts_ the
file is only provable on deploy — there is no local runtime.

### The credential is not a secret

It is base64 (not a hash) in the function's code, and it is in Terraform state.
Anyone with `cloudfront:GetFunction` can read it. It exists so an unauthenticated
console is not on the open internet before real auth lands — nothing more. Use a
throwaway password.

## Nothing is cached

Both behaviors use `Managed-CachingDisabled`: the SPA so a redeploy is visible
without an invalidation, the API because its responses are per-request state. That
is a deliberate demo trade-off — a production console would cache the hashed assets
under `/assets/` and invalidate `index.html`.

## Usage

```bash
cp terraform.tfvars.example terraform.tfvars   # then fill it in
terraform init
terraform apply
terraform output console_url
```

The distribution takes **5–15 minutes** to deploy, so the URL will not answer
immediately. `console/api/infra` has to be applied first — its `api_endpoint`
output is an input here.

To check the API is reachable through the distribution:

```bash
curl -i -u 'demo:<password>' "$(terraform output -raw console_url)/api/health"
# → {"status":"ok"}
```

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
| `basic_auth_username` | string | —                   | No colons (basic auth splits on the first one).           |
| `basic_auth_password` | string | —                   | Minimum 12 characters. Sensitive, but see above.          |
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
