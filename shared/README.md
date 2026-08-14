# @cloudfront-redirect-rules/shared

The **single source of truth** for redirect/rewrite rule shapes. Both stacks consume these schemas:

- `infra/` — the Lambda@Edge reads items in exactly this shape from DynamoDB
- `console/api` — the API validates and writes items in exactly this shape; the OpenAPI spec `$ref`s these schemas for its request/response bodies (never redefine rule shapes inline)

These schemas model the exact DynamoDB **item** shape the edge reads, derived from the source project's `redirect-rule-types.ts` (`EdgeRedirectRule` / `ForwardRewriteRule` / `MatchCondition`). Not to be confused with the source project's hostname-keyed YAML _authoring-file_ schemas — that was the rejected snippet framework's format, a different layer.

**Rule shape notes**

- **Match conditions** use `matchType` / `matchOperator` / `matchValue` (+ optional `negate`, `caseSensitive`, `headerName`). `matchType ∈ {path, hostname, protocol, regex, header, cookie}`, `matchOperator ∈ {equals, contains, regex}`. `headerName` is required iff `matchType` is `header`.
- **`forwardSettings.origin`** (rewrite) is a discriminated union — exactly one of `s3` / `custom` — mirroring the CloudFront `request.origin` structure from `@types/aws-lambda` (the edge assigns it straight through). See both example items.
- **`disabled`** is optional and reserved for a future "toggle off" feature; the source runtime does **not** honor it yet, so ER-101 must skip `disabled: true` rules or it's a no-op.

## Files

| File                        | What                                                              |
| --------------------------- | ----------------------------------------------------------------- |
| `redirect-rule.schema.json` | Redirect item — `type: erMatchRule`, `sk` = `REDIRECT#<priority>` |
| `rewrite-rule.schema.json`  | Rewrite item — `type: frMatchRule`, `sk` = `REWRITE#<priority>`   |
| `examples/`                 | One complete valid DDB item per rule type — validated in CI       |
| `test/validate.ts`          | Validates every example against its schema (`npm test -w shared`) |

## Storage semantics (what JSON Schema can't express)

**Keys**

- `pk` (string) — the host, e.g. `www.example.com`. **Always lowercase.** DNS is case-insensitive but a partition key is not, so the console API lowercases every host it stores or looks up; two cases of one name would otherwise be two partitions, only one of which a request can match.
- `sk` (string) — `TYPE#priority` where `TYPE ∈ {REDIRECT, REWRITE}` and priority is a **zero-padded 5-digit integer** (e.g. `REDIRECT#00100`). Lower number = higher priority. Priority must be **unique per host per type** — the API enforces this (ER-204); the format itself is enforced by the `sk` `pattern` in each schema.

**The host marker (not a rule)**

One item per table row is not a rule: `sk = "HOST"`, with no other attributes. A host is otherwise only the partition key of its rules, so a host with no rules cannot be listed and would vanish on the next page load — this item is what the console's "add host" writes, and it is deleted with the host.

It is invisible to the edge by construction: both edge queries are `begins_with(sk, "REDIRECT#" | "REWRITE#")`, and `"HOST"` begins with neither. It is equally unaddressable as a rule over the API, whose `sk` parser accepts only `TYPE#priority`. No rule schema describes it, and none should — it has no rule fields.

Anything else reading a whole partition has to choose: listing a host's rules skips it, deleting a host takes it. A reader that forgets shows a rule with no type, priority or action.

**Access patterns**

- The Lambda@Edge **reads**: `Query(pk = host, begins_with(sk, "REDIRECT#"))` on viewer-request, `begins_with(sk, "REWRITE#")` on origin-request. Results are cached in-memory briefly at the edge. The host is lowercased for the lookup, since that is how it is stored; the value a `hostname` match condition is tested against stays as the viewer sent it, so `caseSensitive` still means something. The `begins_with` is also why the edge never sees the host marker.
  - `host` is the hostname the **viewer** asked for, at both events. By origin-request CloudFront has replaced the `Host` header with the origin's domain, so viewer-request stamps the real one on the request for origin-request to read — a rewrite keyed on the header CloudFront leaves behind would query a bucket's or backend's partition and match nothing. See [infra/lambda](../infra/lambda/README.md#the-host-a-rule-is-keyed-on).
- The console API **writes**: Put / Update / Delete of whole items. It never talks to the Lambda@Edge — the table is the only interface.

**Propagation**

Edge cache TTL means a rule change takes effect in **~1 minute**. The UI must communicate this (ER-306 / editors).
