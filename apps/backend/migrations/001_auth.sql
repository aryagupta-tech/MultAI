CREATE TABLE users (
  id uuid PRIMARY KEY,
  google_sub text NOT NULL UNIQUE,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL UNIQUE REFERENCES users(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE devices (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  reauth_secret_hash text CHECK (length(reauth_secret_hash) = 64),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  device_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (device_id, user_id) REFERENCES devices(id, user_id)
);
CREATE INDEX auth_sessions_device_idx ON auth_sessions(device_id);

CREATE TABLE access_tokens (
  token_hash text PRIMARY KEY CHECK (length(token_hash) = 64),
  auth_session_id uuid NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX access_tokens_session_idx ON access_tokens(auth_session_id);

CREATE TABLE refresh_tokens (
  token_hash text PRIMARY KEY CHECK (length(token_hash) = 64),
  auth_session_id uuid NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_session_idx ON refresh_tokens(auth_session_id);

-- OAuth state and completion secrets are stored only as hashes. The short-lived
-- Google PKCE verifier is deleted immediately after callback exchange.
CREATE TABLE oauth_flows (
  id uuid PRIMARY KEY,
  state_hash text NOT NULL UNIQUE CHECK (length(state_hash) = 64),
  nonce text NOT NULL,
  desktop_challenge text NOT NULL,
  desktop_client_id text NOT NULL CHECK (desktop_client_id = 'multai-desktop-development'),
  desktop_callback_uri text NOT NULL,
  provider_redirect_uri text NOT NULL,
  provider_client_id text,
  provider_verifier text,
  expires_at timestamptz NOT NULL,
  state_consumed_at timestamptz,
  completion_hash text,
  identity jsonb,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
