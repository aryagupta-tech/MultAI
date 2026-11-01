-- Read-only replay links the original host shares. Only the token's hash is stored.
CREATE TABLE replay_links (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX replay_links_session ON replay_links(session_id) WHERE revoked_at IS NULL;
