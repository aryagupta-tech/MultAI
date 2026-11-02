-- When an access token was first used. A refresh whose response was lost can be retried briefly, but only
-- while the tokens it issued are still unused.
ALTER TABLE access_tokens ADD COLUMN used_at timestamptz;
