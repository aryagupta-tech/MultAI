CREATE TABLE decisions (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES users(id),
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 8000),
  reason text CHECK (length(reason) <= 2000),
  replaces_id uuid REFERENCES decisions(id) ON DELETE CASCADE,
  replaced_by uuid REFERENCES decisions(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX decisions_current ON decisions(session_id) WHERE replaced_by IS NULL;
CREATE TABLE execution_runs (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  fingerprint text NOT NULL,
  owner_id uuid NOT NULL REFERENCES users(id),
  device_id uuid NOT NULL REFERENCES devices(id),
  auth_session_id uuid NOT NULL REFERENCES auth_sessions(id),
  instruction_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
  generation integer NOT NULL CHECK (generation > 0),
  service_epoch uuid NOT NULL,
  lease_hash text NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('running','completed','failed','stopped','uncertain')),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE(owner_id, request_id)
);
CREATE UNIQUE INDEX one_running_execution ON execution_runs(session_id) WHERE status='running';
CREATE TABLE execution_actions (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES execution_runs(id) ON DELETE CASCADE,
  fingerprint text NOT NULL,
  descriptor jsonb NOT NULL CHECK (octet_length(descriptor::text) <= 131072),
  status text NOT NULL CHECK (status IN ('pending','approved','rejected','consumed','canceled','completed','uncertain')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz
);
CREATE UNIQUE INDEX one_pending_action ON execution_actions(run_id) WHERE status='pending';
CREATE TABLE runtime_event_receipts (
  run_id uuid NOT NULL REFERENCES execution_runs(id) ON DELETE CASCADE,
  event_id uuid NOT NULL,
  fingerprint text NOT NULL,
  sequence integer NOT NULL,
  PRIMARY KEY(run_id,event_id)
);
