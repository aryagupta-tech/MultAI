#!/usr/bin/env bash
set -euo pipefail
umask 077
if [[ $# -ne 1 || "$1" != /* || -e "$1" ]]; then
  echo 'Usage: bash deploy/scripts/prepare-secrets.sh /absolute/new/private-directory' >&2
  echo 'The directory must not already exist. Existing secrets are never overwritten.' >&2
  exit 1
fi
directory="$1"
mkdir -m 0700 "$directory"
python3 -c 'import secrets; print(secrets.token_hex(32))' >"$directory/db-admin-password"
python3 -c 'import secrets; print(secrets.token_hex(32))' >"$directory/db-app-password"
printf 'Fresh Google web client ID: ' >&2
IFS= read -r client_id
printf 'Fresh Google web client secret (hidden): ' >&2
IFS= read -r -s client_secret
printf '\n' >&2
if [[ -z "$client_id" || -z "$client_secret" || "$client_id" == *'<'* || "$client_secret" == *'<'* ]]; then
  echo 'Real fresh OAuth values are required. Remove this incomplete private directory before retrying.' >&2
  exit 1
fi
printf '%s\n' "$client_id" >"$directory/google-client-id"
printf '%s\n' "$client_secret" >"$directory/google-client-secret"
unset client_id client_secret
# Private host directory prevents traversal by other accounts; distinct container
# UIDs can read the individual read-only bind mounts without a plaintext env file.
chmod 0444 "$directory/db-admin-password" "$directory/db-app-password" "$directory/google-client-id" "$directory/google-client-secret"
echo 'Created private service secrets. Values were not printed.'
