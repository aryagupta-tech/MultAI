-- Team requirements and host-reported, revision-bound evidence. No code executes here.
CREATE TABLE acceptance_workspaces (
  session_id uuid PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  revision text CHECK (revision ~ '^[a-f0-9]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE acceptance_criteria (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  author_id uuid NOT NULL,
  author_kind text NOT NULL CHECK (author_kind IN ('participant','browser')),
  author_name text NOT NULL,
  text text NOT NULL,
  check_command text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  state text NOT NULL DEFAULT 'proposed' CHECK (state IN ('proposed','approved','withdrawn')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX acceptance_criteria_session ON acceptance_criteria(session_id,created_at,id);
CREATE TABLE acceptance_evidence (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  criterion_id uuid NOT NULL REFERENCES acceptance_criteria(id) ON DELETE CASCADE,
  criterion_version integer NOT NULL CHECK (criterion_version > 0),
  sequence integer NOT NULL CHECK (sequence > 0),
  revision text NOT NULL CHECK (revision ~ '^[a-f0-9]{64}$'),
  kind text NOT NULL CHECK (kind IN ('command','manual')),
  command text,
  exit_code integer,
  output text NOT NULL,
  timed_out boolean NOT NULL DEFAULT false,
  canceled boolean NOT NULL DEFAULT false,
  duration_ms integer,
  host_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind='command' AND command IS NOT NULL) OR (kind='manual' AND command IS NULL AND exit_code IS NULL)),
  CHECK (duration_ms IS NULL OR duration_ms >= 0)
);
CREATE INDEX acceptance_evidence_latest ON acceptance_evidence(criterion_id,sequence DESC);
CREATE TABLE acceptance_reviews (
  evidence_id uuid NOT NULL REFERENCES acceptance_evidence(id) ON DELETE CASCADE,
  reviewer_id uuid NOT NULL,
  reviewer_kind text NOT NULL CHECK (reviewer_kind IN ('participant','browser')),
  reviewer_name text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('accept','reject')),
  comment text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(evidence_id,reviewer_kind,reviewer_id)
);
CREATE TABLE acceptance_requests (
  actor_key text NOT NULL,
  request_id uuid NOT NULL,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  fingerprint text NOT NULL,
  response jsonb NOT NULL,
  PRIMARY KEY(actor_key,request_id)
);
