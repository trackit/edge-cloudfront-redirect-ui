#!/usr/bin/env bash
#
# Creates the two demo accounts in the console's Cognito pool.
#
# Run from this directory, after `terraform apply` — the pool id and region are
# read from the Terraform outputs, so there is nothing to edit:
#
#   ./seed-users.sh
#
# One account per role, named for the role it holds, so the difference is visible
# without explaining it: sign in as the viewer and the console's write controls
# are dead; sign in as the editor and they are not.
#
# Safe to re-run. An account that already exists keeps its password and is only
# re-added to its group, so re-running repairs group membership without locking
# anyone out of a session they are already using.
#
# Passwords are generated per run and printed once, at the end. Nothing is
# written to disk and no password is committed here — a known credential in a
# repository would be a real hole for a control plane that can repoint production
# traffic, demo or not.
set -euo pipefail

cd "$(dirname "$0")"

for cmd in terraform aws; do
  command -v "$cmd" >/dev/null || {
    echo "error: $cmd is not installed" >&2
    exit 1
  }
done

# Overridable so this can seed a pool this state did not create.
USER_POOL_ID="${USER_POOL_ID:-$(terraform output -raw user_pool_id)}"
REGION="${REGION:-$(terraform output -raw region 2>/dev/null || aws configure get region)}"

if [[ -z $USER_POOL_ID || -z $REGION ]]; then
  echo "error: could not read the Terraform outputs. Has 'terraform apply' run?" >&2
  exit 1
fi

# example.com is reserved by RFC 2606, so these can never collide with a real
# mailbox — which matters because Cognito would otherwise send a real person the
# verification mail for an account they did not ask for.
VIEWER_EMAIL="${VIEWER_EMAIL:-viewer@example.com}"
EDITOR_EMAIL="${EDITOR_EMAIL:-editor@example.com}"

echo "seeding demo users into ${USER_POOL_ID} (${REGION})"

# Meets the pool's policy: 12+ characters with all four classes. The symbol and
# digit are fixed so a random draw can never produce a password the policy
# rejects, and the rest is 24 hex characters from the system CSPRNG.
generate_password() {
  printf 'Aa1!%s' "$(openssl rand -hex 12)"
}

user_exists() {
  aws cognito-idp admin-get-user \
    --region "$REGION" \
    --user-pool-id "$USER_POOL_ID" \
    --username "$1" \
    --no-cli-pager >/dev/null 2>&1
}

# `--message-action SUPPRESS` because the address is a reserved example one: the
# invitation mail cannot be delivered, and Cognito failing to send it would fail
# the create.
create_user() {
  aws cognito-idp admin-create-user \
    --region "$REGION" \
    --user-pool-id "$USER_POOL_ID" \
    --username "$1" \
    --user-attributes "Name=email,Value=$1" "Name=email_verified,Value=true" \
    --message-action SUPPRESS \
    --no-cli-pager >/dev/null
}

# `--permanent` skips the FORCE_CHANGE_PASSWORD state a temporary password lands
# in. Without it the first demo login is a change-password screen rather than the
# console, which is not what anyone opened the demo to see.
set_password() {
  aws cognito-idp admin-set-user-password \
    --region "$REGION" \
    --user-pool-id "$USER_POOL_ID" \
    --username "$1" \
    --password "$2" \
    --permanent \
    --no-cli-pager >/dev/null
}

add_to_group() {
  aws cognito-idp admin-add-user-to-group \
    --region "$REGION" \
    --user-pool-id "$USER_POOL_ID" \
    --username "$1" \
    --group-name "$2" \
    --no-cli-pager >/dev/null
}

# Collected and printed together at the end, so a password is not scrolled off
# the top by the progress lines below it.
declare -a CREATED=()

seed_user() {
  local email="$1" group="$2" password

  if user_exists "$email"; then
    # Left alone on purpose: resetting it would invalidate a password someone is
    # already using, and the common reason to re-run this is a group that did not
    # get assigned.
    echo "  ${email} already exists — password unchanged"
  else
    password="$(generate_password)"
    create_user "$email"
    set_password "$email" "$password"
    CREATED+=("${email}  ${password}")
    echo "  ${email} created"
  fi

  add_to_group "$email" "$group"
  echo "  ${email} in group ${group}"
}

seed_user "$VIEWER_EMAIL" viewer
seed_user "$EDITOR_EMAIL" editor

if [[ ${#CREATED[@]} -gt 0 ]]; then
  echo
  echo "Passwords, shown once — they are not stored anywhere:"
  printf '  %s\n' "${CREATED[@]}"
  echo
  echo "Sign in at the console's /login."
fi
