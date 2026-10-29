#!/usr/bin/env bash
# Explicit operator action. This script does not create a bucket or schedule itself.
set -euo pipefail
umask 077
if [[ $# -ne 4 ]]; then
  echo 'Usage: bash deploy/scripts/backup.sh /absolute/production.env private-bucket fresh-resource-id age1-public-recipient' >&2
  exit 1
fi
config="$1"; bucket="$2"; resource_id="$3"; recipient="$4"
if [[ "$config" != /* || ! -f "$config" || ! "$bucket" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ || ! "$resource_id" =~ ^[a-z0-9][a-z0-9-]{2,40}$ || ! "$recipient" =~ ^age1[a-z0-9]+$ ]]; then
  echo 'Invalid backup configuration. No request was sent.' >&2
  exit 1
fi
for tool in docker python3 age aws sha256sum; do command -v "$tool" >/dev/null || { echo "Missing operator tool: $tool" >&2; exit 1; }; done
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
compose="$script_dir/../compose.production.yaml"
export AWS_PAGER='' AWS_CLI_AUTO_PROMPT=off AWS_DEFAULT_REGION=ap-south-1
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
file="$work/backup.dump.age"
if ! aws s3api get-bucket-versioning --bucket "$bucket" >"$work/versioning.json" 2>"$work/private-errors"; then echo 'Could not verify the reviewed backup retention configuration.' >&2; exit 1; fi
python3 - "$work/versioning.json" <<'PY'
import json,sys
if json.load(open(sys.argv[1])).get('Status') == 'Enabled':
    raise SystemExit('Versioned bucket storage is outside this reviewed retention budget.')
PY
# pg_dump custom archives are transactionally consistent; no plaintext file exists.
if ! docker compose --env-file "$config" -f "$compose" exec -T --user postgres database pg_dump -U multai_admin -d multai --format=custom --no-owner --no-acl 2>"$work/private-errors" \
  | python3 "$script_dir/bounded-stream.py" 268435456 \
  | age --encrypt --recipient "$recipient" >"$file"; then
  echo 'Encrypted backup failed or exceeded the reviewed 256 MiB dump budget. Nothing was uploaded.' >&2
  exit 1
fi
sha256sum "$file" | awk '{print $1}' >"$file.sha256"
daily="multai-backups/$resource_id/daily/$(date -u +%F).dump.age"
upload(){
  aws s3 cp "$file" "s3://$bucket/$1" --only-show-errors --sse AES256 >/dev/null 2>"$work/private-errors" \
    && aws s3 cp "$file.sha256" "s3://$bucket/$1.sha256" --only-show-errors --sse AES256 >/dev/null 2>"$work/private-errors"
}
if ! upload "$daily"; then echo 'Backup upload was not confirmed. Existing prior-day backups were not changed.' >&2; exit 1; fi
if [[ "$(date -u +%u)" == 7 ]]; then
  if ! upload "multai-backups/$resource_id/weekly/$(date -u +%G-W%V).dump.age"; then echo 'Daily backup uploaded, but weekly backup was not confirmed.' >&2; exit 1; fi
fi
for kind in daily weekly; do
  if ! aws s3api list-objects-v2 --bucket "$bucket" --prefix "multai-backups/$resource_id/$kind/" --max-keys 1000 --no-paginate >"$work/list.json" 2>"$work/private-errors"; then echo 'Backup uploaded, but retention listing failed.' >&2; exit 1; fi
  python3 "$script_dir/prune-backups.py" "multai-backups/$resource_id/" "$kind" <"$work/list.json" >"$work/expired"
  while IFS= read -r key; do
    if ! aws s3 rm "s3://$bucket/$key" --only-show-errors >/dev/null 2>"$work/private-errors"; then echo 'Backup uploaded, but one scoped retention deletion failed.' >&2; exit 1; fi
  done <"$work/expired"
done
echo 'Encrypted off-instance backup upload confirmed; scoped 7-day/4-week retention applied.'
