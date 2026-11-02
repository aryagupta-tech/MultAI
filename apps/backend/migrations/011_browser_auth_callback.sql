-- Browser OAuth completion must not match Android's verified /app and /app/ invitation paths.
-- Keep the former /app/ destination valid for historical and in-flight records; application code
-- accepts it only at the configured service origin and redirects completion to /app/auth.
ALTER TABLE oauth_flows DROP CONSTRAINT oauth_flows_desktop_identity_check;
ALTER TABLE oauth_flows ADD CONSTRAINT oauth_flows_desktop_identity_check CHECK (
  (desktop_client_id = 'multai-desktop-development' AND desktop_callback_uri = 'multai-dev://auth/callback')
  OR (desktop_client_id = 'multai-desktop' AND desktop_callback_uri = 'multai://auth/callback')
  OR (desktop_client_id = 'multai-companion-android-development' AND desktop_callback_uri = 'multai-companion-dev://auth/callback')
  OR (desktop_client_id = 'multai-companion-android' AND desktop_callback_uri = 'multai-companion://auth/callback')
  OR (desktop_client_id = 'multai-companion-web-development' AND desktop_callback_uri ~ '^http(s)?://[A-Za-z0-9.:\[\]-]+/app/(auth)?$')
  OR (desktop_client_id = 'multai-companion-web' AND desktop_callback_uri ~ '^https://[A-Za-z0-9.-]+/app/(auth)?$')
);
