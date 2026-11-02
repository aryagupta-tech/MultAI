-- Paired owner controllers: a phone the original host explicitly paired. A controller is never a
-- native account; it holds no execution authority. It can only ask the original host, which verifies
-- each signed request with the key it confirmed and executes it with its own authority.
CREATE TABLE controller_pairings (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  host_device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  code_hash text UNIQUE,
  code_expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'awaiting_device' CHECK (status IN ('awaiting_device','awaiting_confirmation','active','declined','revoked')),
  session_ids uuid[] NOT NULL CHECK (cardinality(session_ids) BETWEEN 1 AND 20),
  grant_seconds integer NOT NULL CHECK (grant_seconds BETWEEN 3600 AND 2592000),
  claim_request_id uuid,
  claim_fingerprint text,
  device_name text,
  device_platform text CHECK (device_platform IS NULL OR device_platform IN ('android','ios','web')),
  signing_key jsonb,
  encryption_key jsonb,
  key_thumbprint text CHECK (key_thumbprint IS NULL OR key_thumbprint ~ '^[a-f0-9]{64}$'),
  token_hash text UNIQUE,
  claimed_at timestamptz,
  confirmed_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by text CHECK (revoked_by IS NULL OR revoked_by IN ('host','controller','expiry')),
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX controller_pairings_host ON controller_pairings(owner_id,host_device_id,created_at DESC);

CREATE TABLE control_requests (
  id uuid PRIMARY KEY,
  pairing_id uuid NOT NULL REFERENCES controller_pairings(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('start','resolve','stop','steer','approve','reject')),
  envelope jsonb NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  signature text NOT NULL,
  run_generation integer NOT NULL CHECK (run_generation > 0),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','accepted','rejected','expired','canceled')),
  result_code text,
  result_message text,
  delivered_at timestamptz,
  acknowledged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX control_requests_open ON control_requests(session_id,status) WHERE status IN ('pending','delivered');
CREATE INDEX control_requests_pairing ON control_requests(pairing_id,created_at DESC);

-- What the original host last reported about a session, for paired controllers. Never authority.
CREATE TABLE host_control_state (
  session_id uuid PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  host_device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  state jsonb NOT NULL CHECK (octet_length(state::text) <= 32768),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE controller_audit (
  id uuid PRIMARY KEY,
  pairing_id uuid NOT NULL REFERENCES controller_pairings(id) ON DELETE CASCADE,
  session_id uuid,
  event text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX controller_audit_pairing ON controller_audit(pairing_id,created_at DESC);

-- Companion sign-ins share the Google redirect and differ only in their fixed completion callback.
ALTER TABLE oauth_flows DROP CONSTRAINT oauth_flows_desktop_identity_check;
ALTER TABLE oauth_flows ADD CONSTRAINT oauth_flows_desktop_identity_check CHECK (
  (desktop_client_id = 'multai-desktop-development' AND desktop_callback_uri = 'multai-dev://auth/callback')
  OR (desktop_client_id = 'multai-desktop' AND desktop_callback_uri = 'multai://auth/callback')
  OR (desktop_client_id = 'multai-companion-android-development' AND desktop_callback_uri = 'multai-companion-dev://auth/callback')
  OR (desktop_client_id = 'multai-companion-android' AND desktop_callback_uri = 'multai-companion://auth/callback')
  OR (desktop_client_id = 'multai-companion-web-development' AND desktop_callback_uri ~ '^http(s)?://[A-Za-z0-9.:\[\]-]+/app/$')
  OR (desktop_client_id = 'multai-companion-web' AND desktop_callback_uri ~ '^https://[A-Za-z0-9.-]+/app/$')
);
