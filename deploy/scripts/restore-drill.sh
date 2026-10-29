#!/usr/bin/env bash
# Isolated verification only: never restores into a live deployment or publishes ports.
set -euo pipefail
umask 077
if [[ $# -ne 2 || ! -f "$1" || ! -f "$1.sha256" || ! -f "$2" ]]; then
  echo 'Usage: bash deploy/scripts/restore-drill.sh /absolute/backup.dump.age /private/offline/age-identity.key' >&2
  exit 1
fi
backup="$1"; identity="$2"
for tool in docker age sha256sum python3; do command -v "$tool" >/dev/null || { echo "Missing operator tool: $tool" >&2; exit 1; }; done
expected="$(head -n 1 "$backup.sha256")"
actual="$(sha256sum "$backup" | awk '{print $1}')"
if [[ ! "$expected" =~ ^[a-f0-9]{64}$ || "$expected" != "$actual" ]]; then echo 'Encrypted backup checksum mismatch. No restoration was attempted.' >&2; exit 1; fi
if [[ -L "$identity" ]]; then echo 'Select the actual private identity file, not a symbolic link.' >&2; exit 1; fi
python3 - "$identity" <<'PY'
import os,stat,sys
if stat.S_IMODE(os.stat(sys.argv[1]).st_mode)&0o077:
    raise SystemExit('The offline age identity must have private 0600/0400 permissions.')
PY
name="multai-restore-$(python3 -c 'import uuid;print(uuid.uuid4().hex)')"
work="$(mktemp -d)"
started=false
cleanup(){
  if [[ "$started" == true ]]; then docker stop --timeout 3 "$name" >/dev/null 2>&1 || true; fi
  rm -rf -- "$work"
}
trap cleanup EXIT
image='postgres:18-alpine@sha256:10a5c69a83035ab5239f5620d708520e8b28f5aa1f2b20143e6024532edadfb5'
# Trust is confined to this disposable network-none container; no TCP port,
# cloud credential, live volume or Docker socket is mounted inside it.
docker run --detach --rm --name "$name" --network none --user postgres --read-only --cap-drop ALL --security-opt no-new-privileges:true --memory 1536m --cpus 1 --pids-limit 128 --log-driver none \
  --tmpfs /var/lib/postgresql:rw,noexec,nosuid,nodev,size=1g,mode=1777 \
  --tmpfs /var/run/postgresql:rw,noexec,nosuid,nodev,size=16m,mode=1777 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=32m,mode=1777 \
  -e POSTGRES_HOST_AUTH_METHOD=trust "$image" postgres -c log_min_error_statement=panic -c log_error_verbosity=terse >/dev/null
started=true
ready=false
for _ in $(seq 1 60); do
  if docker exec "$name" pg_isready -U postgres -d postgres >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
if [[ "$ready" != true ]]; then echo 'The disposable restore database did not become ready.' >&2; exit 1; fi
if ! age --decrypt --identity "$identity" "$backup" 2>"$work/private-errors" | docker exec -i "$name" pg_restore -U postgres -d postgres --exit-on-error --no-owner --no-acl >/dev/null 2>"$work/private-errors"; then
  echo 'Backup decryption or isolated database restoration failed. The live deployment was not touched.' >&2
  exit 1
fi
if ! docker exec -i "$name" psql -U postgres -d postgres --set ON_ERROR_STOP=1 >/dev/null 2>"$work/private-errors" <<'SQL'
BEGIN;
UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,now());
UPDATE devices SET revoked_at=COALESCE(revoked_at,now());
DELETE FROM oauth_flows;
UPDATE execution_actions SET status=CASE WHEN status='consumed' THEN 'uncertain' ELSE 'canceled' END WHERE status IN ('pending','approved','consumed');
UPDATE execution_runs SET status='uncertain',finished_at=now() WHERE status='running';
UPDATE sessions SET status='paused',runtime_generation=runtime_generation+1 WHERE deleted_at IS NULL;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM schema_migrations) THEN RAISE EXCEPTION 'Missing migration evidence'; END IF;
  IF EXISTS(SELECT 1 FROM auth_sessions WHERE revoked_at IS NULL) OR EXISTS(SELECT 1 FROM execution_runs WHERE status='running') THEN RAISE EXCEPTION 'Restored authority was not fenced'; END IF;
END $$;
COMMIT;
SQL
then echo 'Restored schema or recovery fencing failed. No live deployment was changed.' >&2; exit 1; fi
echo 'Isolated encrypted restore drill passed with all restored account/device/runtime authority revoked.'
echo 'This database is discarded now. Production promotion requires deletion/revocation reconciliation and a separate reviewed recovery procedure.'
