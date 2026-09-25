#!/usr/bin/env bash
#
# Smoke-tests country conditions against the example's real distribution.
#
# Run from this directory, after `terraform apply`, from a machine whose country
# you know — CloudFront places the caller by IP, so that is what is tested:
#
#   MY_COUNTRY=FR ./smoke-geo.sh
#
# What it proves, one check each:
#
#   1. the country reaches the function: a redirect for MY_COUNTRY fires;
#   2. an exclusion works: a redirect for "anywhere but MY_COUNTRY" does not;
#   3. classic redirects run first: a classic and a geo redirect on the same
#      path, the geo one at the better priority — the classic one must answer;
#   4. the country cannot be forged: a redirect for another country does not
#      fire when the request claims that country in CloudFront-Viewer-Country.
#
# The rules live under /geo-smoke/ at priorities 09010–09050, which the demo
# does not use, and are deleted on exit (KEEP=1 keeps them for a look in the
# console). Only point this at a table whose host is yours to test on.
#
# Writes straight to DynamoDB, like seed-demo.sh, so the items have to match
# the shared schemas exactly — see shared/README.md.
set -euo pipefail

cd "$(dirname "$0")"

for cmd in terraform aws curl; do
  command -v "$cmd" >/dev/null || {
    echo "error: $cmd is not installed" >&2
    exit 1
  }
done

MY_COUNTRY="${MY_COUNTRY:-}"
if [[ ! $MY_COUNTRY =~ ^[A-Z]{2}$ ]]; then
  echo "error: set MY_COUNTRY to this machine's country, e.g. MY_COUNTRY=FR" >&2
  exit 1
fi
# Any country that is not ours, for the forgery check.
OTHER_COUNTRY="US"
[[ $MY_COUNTRY == "US" ]] && OTHER_COUNTRY="CA"

TABLE_NAME="${TABLE_NAME:-$(terraform output -raw table_name)}"
REGION="${REGION:-$(terraform output -raw table_region)}"
HOST="${HOST:-$(terraform output -raw cloudfront_domain_name)}"
# Rules reach the edge within the function's rule cache TTL (60s by default).
WAIT_SECONDS="${WAIT_SECONDS:-65}"

if [[ -z $TABLE_NAME || -z $REGION || -z $HOST ]]; then
  echo "error: could not read the Terraform outputs. Has 'terraform apply' run?" >&2
  exit 1
fi

SORT_KEYS=(REDIRECT#09010 REDIRECT#09020 REDIRECT#09030 REDIRECT#09040 REDIRECT#09050)

cleanup() {
  if [[ ${KEEP:-0} == 1 ]]; then
    echo "KEEP=1: leaving the /geo-smoke/ rules in place"
    return
  fi
  for sk in "${SORT_KEYS[@]}"; do
    aws dynamodb delete-item \
      --region "$REGION" \
      --table-name "$TABLE_NAME" \
      --key "{\"pk\": {\"S\": \"${HOST}\"}, \"sk\": {\"S\": \"${sk}\"}}" \
      --no-cli-pager >/dev/null || echo "warning: could not delete ${sk}" >&2
  done
  echo "removed the /geo-smoke/ rules"
}
trap cleanup EXIT

put_redirect() {
  local sk=$1 status=$2 target=$3 path=$4 country_json=$5
  aws dynamodb put-item \
    --region "$REGION" \
    --table-name "$TABLE_NAME" \
    --no-cli-pager >/dev/null \
    --item "$(
      cat <<JSON
{
  "pk": {"S": "${HOST}"},
  "sk": {"S": "${sk}"},
  "type": {"S": "erMatchRule"},
  "statusCode": {"N": "${status}"},
  "redirectURL": {"S": "${target}"},
  "useIncomingQueryString": {"BOOL": false},
  "matches": {"L": [
    {"M": {
      "matchType": {"S": "path"},
      "matchOperator": {"S": "equals"},
      "matchValue": {"S": "${path}"},
      "negate": {"BOOL": false},
      "caseSensitive": {"BOOL": false}
    }}${country_json}
  ]},
  "disabled": {"BOOL": false}
}
JSON
    )"
}

country() {
  cat <<JSON
,
    {"M": {
      "matchType": {"S": "country"},
      "matchOperator": {"S": "$1"},
      "matchValue": {"S": "$2"},
      "negate": {"BOOL": false},
      "caseSensitive": {"BOOL": false}
    }}
JSON
}

echo "seeding /geo-smoke/ rules for ${HOST} into ${TABLE_NAME} (${REGION})"
put_redirect REDIRECT#09010 302 "https://example.com/geo-smoke/in" \
  /geo-smoke/in "$(country equals "$MY_COUNTRY")"
put_redirect REDIRECT#09020 302 "https://example.com/geo-smoke/out" \
  /geo-smoke/out "$(country notEquals "$MY_COUNTRY")"
put_redirect REDIRECT#09030 302 "https://example.com/geo-smoke/order-geo" \
  /geo-smoke/order "$(country equals "$MY_COUNTRY")"
put_redirect REDIRECT#09040 301 "https://example.com/geo-smoke/order-classic" \
  /geo-smoke/order ""
put_redirect REDIRECT#09050 302 "https://example.com/geo-smoke/forged" \
  /geo-smoke/spoof "$(country equals "$OTHER_COUNTRY")"

echo "waiting ${WAIT_SECONDS}s for the edge's rule cache (WAIT_SECONDS to change)"
sleep "$WAIT_SECONDS"

failures=0

# Prints "<status> <location>" for a request, following nothing.
probe() {
  local path=$1
  shift
  curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "$@" \
    "https://${HOST}${path}?smoke=${RANDOM}"
}

check() {
  local label=$1 expected=$2 actual=$3
  if [[ $actual == "$expected"* ]]; then
    echo "  PASS  ${label}"
  else
    echo "  FAIL  ${label}: expected '${expected}…', got '${actual}'"
    failures=$((failures + 1))
  fi
}

# The origin has no page at these paths, so "no redirect" is any status but a
# 301 or 302 — a 403 or 404 from the placeholder origin included.
check_no_redirect() {
  local label=$1 actual=$2
  case $actual in
    301* | 302*)
      echo "  FAIL  ${label}: got a redirect, '${actual}'"
      failures=$((failures + 1))
      ;;
    *) echo "  PASS  ${label}" ;;
  esac
}

echo "checking (this machine should be in ${MY_COUNTRY})"
check "1. a redirect for ${MY_COUNTRY} fires" \
  "302 https://example.com/geo-smoke/in" "$(probe /geo-smoke/in)"
check_no_redirect "2. an exclusion of ${MY_COUNTRY} does not fire" \
  "$(probe /geo-smoke/out)"
check "3. the classic redirect answers before the geo one" \
  "301 https://example.com/geo-smoke/order-classic" "$(probe /geo-smoke/order)"
check_no_redirect "4. claiming ${OTHER_COUNTRY} in the header changes nothing" \
  "$(probe /geo-smoke/spoof -H "CloudFront-Viewer-Country: ${OTHER_COUNTRY}")"

if ((failures > 0)); then
  cat <<EOF

${failures} check(s) failed. The usual causes:
  - 1 fails: the behavior does not ask for CloudFront-Viewer-Country, or
    MY_COUNTRY is not where CloudFront places this machine (VPN?). The function
    logs "country rules, but no viewer country at origin-request" in the region
    of the edge location, under /aws/lambda/us-east-1.<function_name>.
  - 4 answers 302: CloudFront passed the viewer's own header through. Report it.
EOF
  exit 1
fi

echo
echo "All geo checks passed."
