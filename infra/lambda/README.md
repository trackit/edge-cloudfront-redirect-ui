# @cloudfront-redirect-rules/lambda

The Lambda@Edge data plane (ER-102). **One** function, associated twice on your distribution:

| Association    | Sort key prefix                                        | Behavior                                                                                                       |
| -------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| viewer-request | `REDIRECT#`                                            | Returns a 301/302 response on match                                                                            |
| origin-request | `REWRITE#`, and `REDIRECT#` with a `country` condition | Rewrites `uri`/`querystring` and/or switches `request.origin` on match; answers the 301/302 for a geo redirect |

It dispatches on `cf.config.eventType`, so both associations point at the same published version. Any other event type passes through untouched.

Extracted from `edge-platform-functions-cdn`'s `src/snippets/dynamodb-redirect/`, with the snippet registry, bindings, pipeline, and logger framework dropped — this is a plain handler.

## Rule evaluation

1. `Query(pk = <the viewer's hostname>, begins_with(sk, "REDIRECT#" | "REWRITE#"))`
   — see [the host a rule is keyed on](#the-host-a-rule-is-keyed-on).
2. Rules with `disabled: true` are dropped, and so are rules the current event
   cannot evaluate — see [the country a rule can be keyed on](#the-country-a-rule-can-be-keyed-on).
3. Remaining rules are evaluated in ascending sort-key order (`REDIRECT#00010` before `REDIRECT#00100`) — lower priority number wins.
4. The **first** rule whose `matches` **all** pass is applied; the rest are ignored.
5. No match → the request passes through unmodified.

A DynamoDB error is logged and the request passes through — rules never fail a request.

## The host a rule is keyed on

A rule's `pk` is the hostname the viewer asked for. Only viewer-request sees it:
CloudFront replaces the `Host` header with the **origin's** domain before
origin-request fires, so a rewrite looked up there would query the partition of a
bucket or backend — which holds no rules, so every rewrite silently never matches.

So viewer-request stamps the viewer's hostname on the request as
`X-EdgeRoute-Viewer-Host`, and origin-request prefers that header over `Host`. The
header is set unconditionally, overwriting anything the viewer sent — otherwise a
request could name any host and be matched by its rules. origin-request drops it
before the request reaches the origin.

| Association attached                  | `pk` a rewrite is looked up under                                                      |
| ------------------------------------- | -------------------------------------------------------------------------------------- |
| viewer + origin-request (recommended) | the viewer's hostname                                                                  |
| origin-request alone                  | the **origin's** domain — or whatever the client sent, if viewer headers are forwarded |

Attach both — see
[modules/edge](../modules/edge/README.md#wiring-it-into-an-existing-distribution),
where this is written up as a security requirement. The overwrite at
viewer-request is the whole basis for trusting the header at origin-request:
without it, a distribution that forwards viewer headers lets a client stamp the
header itself and pick which host's rules apply to its request. The fallback only
keeps a single-association distribution behaving as it did, and rules written by
the console are keyed on hostnames, so none of them match under it. Reaching
origin-request with nothing stamped logs a warning, once per execution
environment.

## The country a rule can be keyed on

A `country` match condition tests the viewer's country, as an ISO 3166-1 alpha-2
code, against a space-separated list — `"BE FR"` means Belgium or France, and
`negate: true` turns the list into an exclusion.

The value comes from CloudFront's own `CloudFront-Viewer-Country` header, and
**two deployment conditions have to hold** before it carries anything:

**1. The distribution must ask for the header**, in a cache policy or an origin
request policy. CloudFront does not add it otherwise. Prefer a **cache policy**:
the header then belongs to the cache key, so a response that varies by country
cannot be served to the wrong country. An origin request policy forwards the
value without splitting the cache, which is fine for logging and wrong for
routing.

This module publishes the function; it does not own your distribution, so this
is yours to configure. Note the cost: a country in the cache key means up to one
cached copy per country per URL, so a lower hit ratio and more origin traffic.
`examples/infra` uses `Managed-CachingDisabled`, where nothing is cached and the
question does not arise.

**2. The rule must be evaluated at origin-request.** CloudFront works the
country out _after_ the viewer-request event, so at viewer-request the header is
either absent or something the viewer sent itself. A viewer-request function
that sets it makes CloudFront answer the viewer with a 502.

So `getParams` reads the header at origin-request only — the same trust rule as
the viewer host — and a redirect carrying a `country` condition is deferred to
origin-request, where it answers its 301/302 like viewer-request would. The
response is `no-store`, so a redirect decided from one viewer's country is never
handed to the next.

Only those redirects move. An ordinary redirect is evaluated at viewer-request
and **not** re-evaluated at origin-request: that event runs on cache misses
only, so a rule firing there would redirect or not depending on whether
CloudFront happened to hold the page. `readsCountry` in `rules-service.ts` is
the whole test, and it reads the rule rather than the request precisely so that
enabling the header cannot change how any existing rule behaves.

### An unknown country skips the rule

When the country is unknown — the wrong event, or a distribution that never asks
for the header — a rule that reads it is **skipped**, not evaluated.

This is not tidiness. Evaluated against an empty country the comparison fails,
and `negate` then inverts that failure into a match: a rule meaning "redirect
everyone except France" would fire for every request, France included. One rule
would take the site down. Skipping makes the same rule inert instead, which is
why `RequestParams.country` is optional rather than defaulting to `""` — absent
means "unknown", which is not the same as "known, and not France".

A country condition is also not a security control. IP geolocation is an
indication, and a VPN defeats it in seconds. For a legal or licensing block, use
the distribution's own `geo_restriction`, which answers a 403 before any of this
code runs.

## The query string on a rewrite

Two things decide what reaches the origin: any query string in the rule's
`pathAndQS`, and `forwardSettings.useIncomingQueryString`. For a request carrying
`?a=1`:

| `pathAndQS`      | `useIncomingQueryString` | Forwarded |
| ---------------- | ------------------------ | --------- |
| `/api?x=1`       | anything                 | `x=1`     |
| absent           | absent                   | `a=1`     |
| `/api`           | absent                   | `a=1`     |
| absent or `/api` | `true`                   | `a=1`     |
| absent or `/api` | `false`                  | _(empty)_ |

A query string the rule spells out always wins. Otherwise the request's own is
forwarded, and **only an explicit `false` drops it** — an absent flag is not an
opt-out, which is what it has always meant here and in the upstream snippet, so
rules written by hand against either behave the same.

The equivalent flag on a redirect is the other way round: `redirectURL` is used
as written, and the incoming query string is appended only when
`useIncomingQueryString` is `true`.

> The upstream snippet this was extracted from resolves the flag correctly and
> then never applies it — its origin-request handler only assigns
> `request.querystring` when the resolved path contains a `?`, so an opt-out is a
> no-op there. Fixing that is a deliberate divergence, not drift.

## Config

Lambda@Edge does not support environment variables, so config is **baked into the bundle**
at package time (the ER-102 decision in [`../README.md`](../README.md)): Terraform renders
`edge-config.generated.ts` into its own build directory and packages it into the zip —
see [modules/edge](../modules/edge/README.md#using-the-module-more-than-once). It is not
written into this workspace. [`src/edge-config.generated.example.ts`](src/edge-config.generated.example.ts)
records its shape; a local `src/edge-config.generated.ts` is gitignored and read only by
local runs.

Env vars override the baked values when set, which is how tests and local runs configure it.
**They do not resolve at the edge** — don't rely on them in production.

| Setting      | Env var (local/test) | Baked key     | Default  |
| ------------ | -------------------- | ------------- | -------- |
| Table name   | `RULES_TABLE_NAME`   | `tableName`   | required |
| Table region | `RULES_TABLE_REGION` | `tableRegion` | required |
| Cache TTL    | `RULES_CACHE_TTL_MS` | `cacheTtlMs`  | `60000`  |

The cache is per execution environment and keyed by `host:kind`, so a rule change takes up to
TTL + propagation to appear — the ~1 minute quoted in the root README.

## Development

```bash
npm test -w @cloudfront-redirect-rules/lambda        # vitest
npm run typecheck -w @cloudfront-redirect-rules/lambda
```
