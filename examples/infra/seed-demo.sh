#!/usr/bin/env bash
#
# Seeds the demo host and a few rules into the example's rules table.
#
# Run from this directory, after `terraform apply` — the table name, its region
# and the host are read from the Terraform outputs, so there is nothing to edit:
#
#   ./seed-demo.sh
#
# Safe to re-run. Every write is a PutItem on a known key, so it overwrites rather
# than duplicating, and a rule someone edited in the console is reset to what is
# written here. That is the point: it puts the demo back to a known state.
#
# Writes straight to DynamoDB rather than through the console API, so it works
# before the control plane exists. The items therefore have to match the shared
# schemas exactly — see shared/README.md for the key format.
set -euo pipefail

cd "$(dirname "$0")"

for cmd in terraform aws; do
  command -v "$cmd" >/dev/null || {
    echo "error: $cmd is not installed" >&2
    exit 1
  }
done

# Overridable so this can seed a table the example did not create.
TABLE_NAME="${TABLE_NAME:-$(terraform output -raw table_name)}"
REGION="${REGION:-$(terraform output -raw table_region)}"
# The rules' partition key: the hostname a viewer asks for. For the example that
# is the distribution's own domain — see infra/lambda/README.md.
HOST="${HOST:-$(terraform output -raw cloudfront_domain_name)}"

if [[ -z $TABLE_NAME || -z $REGION || -z $HOST ]]; then
  echo "error: could not read the Terraform outputs. Has 'terraform apply' run?" >&2
  exit 1
fi

echo "seeding ${HOST} into ${TABLE_NAME} (${REGION})"

put_item() {
  aws dynamodb put-item \
    --region "$REGION" \
    --table-name "$TABLE_NAME" \
    --item "$1" \
    --no-cli-pager >/dev/null
}

# The host marker. Not a rule: it is what makes the host visible in the console
# when it has no rules, and it is what the console's own "add host" writes. The
# edge never sees it — both its queries are begins_with(sk, "REDIRECT#"|"REWRITE#").
put_item "$(
  cat <<JSON
{
  "pk": {"S": "${HOST}"},
  "sk": {"S": "HOST"}
}
JSON
)"
echo "  host marker"

# A 301 with the query string carried over, which is the common real-world case.
put_item "$(
  cat <<JSON
{
  "pk": {"S": "${HOST}"},
  "sk": {"S": "REDIRECT#00100"},
  "type": {"S": "erMatchRule"},
  "statusCode": {"N": "301"},
  "redirectURL": {"S": "https://example.com/new-landing"},
  "useIncomingQueryString": {"BOOL": true},
  "matches": {"L": [{"M": {
    "matchType": {"S": "path"},
    "matchOperator": {"S": "equals"},
    "matchValue": {"S": "/old-landing"},
    "negate": {"BOOL": false},
    "caseSensitive": {"BOOL": false}
  }}]},
  "disabled": {"BOOL": false}
}
JSON
)"
echo "  REDIRECT#00100  /old-landing -> 301 https://example.com/new-landing"

# A 302, so the list shows more than one kind of redirect. `contains` rather than
# `equals` so /promo and /promo/summer both match.
put_item "$(
  cat <<JSON
{
  "pk": {"S": "${HOST}"},
  "sk": {"S": "REDIRECT#00200"},
  "type": {"S": "erMatchRule"},
  "statusCode": {"N": "302"},
  "redirectURL": {"S": "https://example.com/summer-sale"},
  "useIncomingQueryString": {"BOOL": false},
  "matches": {"L": [{"M": {
    "matchType": {"S": "path"},
    "matchOperator": {"S": "contains"},
    "matchValue": {"S": "/promo"},
    "negate": {"BOOL": false},
    "caseSensitive": {"BOOL": false}
  }}]},
  "disabled": {"BOOL": false}
}
JSON
)"
echo "  REDIRECT#00200  /promo -> 302 https://example.com/summer-sale"

# The rewrite. This one is worth watching: it is evaluated at origin-request,
# where the Host header is the origin's domain, so it only matches because
# viewer-request carried the viewer's hostname across. /pricing.html is a real
# object on the placeholder origin, so the effect is visible in a browser.
put_item "$(
  cat <<JSON
{
  "pk": {"S": "${HOST}"},
  "sk": {"S": "REWRITE#00100"},
  "type": {"S": "frMatchRule"},
  "forwardSettings": {"M": {
    "pathAndQS": {"S": "/pricing.html"},
    "useIncomingQueryString": {"BOOL": true}
  }},
  "matches": {"L": [{"M": {
    "matchType": {"S": "path"},
    "matchOperator": {"S": "equals"},
    "matchValue": {"S": "/old-pricing"},
    "negate": {"BOOL": false},
    "caseSensitive": {"BOOL": false}
  }}]},
  "disabled": {"BOOL": false}
}
JSON
)"
echo "  REWRITE#00100   /old-pricing -> /pricing.html"

cat <<EOF

Done. Rules reach the edge within the cache TTL (60s by default, or whatever
cache_ttl_ms was applied with).

  curl -i https://${HOST}/old-landing    # 301
  curl -i https://${HOST}/promo          # 302
  curl -i https://${HOST}/old-pricing    # 200, the Pricing page

In the console, connect to table "${TABLE_NAME}" in ${REGION} to see these under
the host ${HOST}.
EOF
