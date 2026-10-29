#!/usr/bin/env bash
set -euo pipefail
# This reviewed bootstrap runs only when PostgreSQL initializes a new empty volume.
# PostgreSQL receives the password from an environment variable, never a CLI argument.
MULTAI_APP_DB_PASSWORD="$(cat /run/secrets/db-app-password)"
if [[ ! "$MULTAI_APP_DB_PASSWORD" =~ ^[a-f0-9]{64}$ ]]; then
  echo 'Invalid application database secret.' >&2
  exit 1
fi
export MULTAI_APP_DB_PASSWORD
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 >/dev/null <<'SQL'
\getenv app_password MULTAI_APP_DB_PASSWORD
CREATE ROLE multai_app LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
REVOKE ALL ON DATABASE multai FROM PUBLIC;
GRANT CONNECT ON DATABASE multai TO multai_app;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE,CREATE ON SCHEMA public TO multai_app;
SQL
unset MULTAI_APP_DB_PASSWORD
