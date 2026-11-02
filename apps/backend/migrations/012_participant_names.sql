-- The name a person chose when asking to join a session, shown to everyone in it. NULL keeps their
-- account name. Existing rows are untouched.
ALTER TABLE join_requests ADD COLUMN display_name text CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 60);
ALTER TABLE session_participants ADD COLUMN display_name text CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 60);
