-- Browser reviewers are deliberately separate from native accounts and execution authority.
CREATE TABLE browser_review_invitations (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX browser_review_invitations_session ON browser_review_invitations(session_id);
CREATE TABLE browser_reviewers (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  invitation_id uuid NOT NULL REFERENCES browser_review_invitations(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  fingerprint text NOT NULL,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','admitted','revoked')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invitation_id,request_id)
);
CREATE INDEX browser_reviewers_session ON browser_reviewers(session_id);
CREATE TABLE browser_review_receipts (
  reviewer_id uuid NOT NULL REFERENCES browser_reviewers(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  fingerprint text NOT NULL,
  response jsonb NOT NULL,
  PRIMARY KEY (reviewer_id,request_id)
);
CREATE TABLE browser_review_screenshots (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  label text NOT NULL,
  image text NOT NULL CHECK (octet_length(image)<=110000),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX browser_review_screenshots_session ON browser_review_screenshots(session_id);
