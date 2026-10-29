CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  owner_id uuid NOT NULL REFERENCES users(id),
  host_device_id uuid NOT NULL REFERENCES devices(id),
  title text,
  mode text NOT NULL DEFAULT 'plan' CHECK (mode IN ('plan', 'build')),
  status text NOT NULL DEFAULT 'inactive' CHECK (status IN ('inactive', 'paused', 'running')),
  runtime_generation integer NOT NULL DEFAULT 1 CHECK (runtime_generation > 0),
  event_sequence integer NOT NULL DEFAULT 0 CHECK (event_sequence BETWEEN 0 AND 100000),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE session_participants (
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('owner', 'collaborator', 'viewer')),
  admitted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (session_id, user_id)
);
CREATE INDEX session_participants_user ON session_participants(user_id, session_id) WHERE revoked_at IS NULL;
CREATE TABLE shared_events (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence > 0),
  type text NOT NULL,
  actor_id uuid REFERENCES users(id),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, sequence),
  CHECK (octet_length(payload::text) <= 131072)
);
CREATE TABLE request_results (
  user_id uuid NOT NULL REFERENCES users(id),
  request_id uuid NOT NULL,
  fingerprint text NOT NULL,
  session_id uuid NOT NULL REFERENCES sessions(id),
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, request_id)
);
CREATE TABLE invitations (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invitations_session ON invitations(session_id);
CREATE TABLE join_requests (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  invitation_id uuid NOT NULL REFERENCES invitations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'admitted', 'revoked')),
  admitted_role text CHECK (admitted_role IN ('collaborator', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invitation_id, user_id)
);
CREATE INDEX join_requests_session ON join_requests(session_id, status);
CREATE TABLE instruction_queue (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  event_id uuid NOT NULL UNIQUE REFERENCES shared_events(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'removed')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE deletion_challenges (
  session_id uuid PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  device_id uuid NOT NULL REFERENCES devices(id),
  generation integer NOT NULL,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL
);
-- Minimal deletion metadata permits offline clients to discard cached history.
-- These rows authorize no content access and contain no conversation text.
CREATE TABLE session_tombstone_readers (
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  PRIMARY KEY (session_id, user_id)
);
