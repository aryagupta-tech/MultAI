-- The release desktop app signs in as its own client with its own callback; development builds
-- keep theirs. Pair each client with its callback so neither can complete the other's flow.
ALTER TABLE oauth_flows DROP CONSTRAINT oauth_flows_desktop_client_id_check;
ALTER TABLE oauth_flows ADD CONSTRAINT oauth_flows_desktop_identity_check CHECK (
  (desktop_client_id = 'multai-desktop-development' AND desktop_callback_uri = 'multai-dev://auth/callback')
  OR (desktop_client_id = 'multai-desktop' AND desktop_callback_uri = 'multai://auth/callback')
);
