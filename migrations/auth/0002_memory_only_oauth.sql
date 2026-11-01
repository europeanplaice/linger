-- Revoke every pre-cutover session and remove its stored credentials and session
-- payload. Users must authorize again; a tombstone prevents old cookies returning.
UPDATE auth_sessions
SET data = NULL,
    revoked = 1,
    refresh_owner = NULL,
    refresh_until = 0,
    expires_at = MAX(expires_at, CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 2592000000);

-- D1 is metadata-only after this migration. Allowlisting the entire JSON object
-- means a future credential field cannot silently start persisting here.
CREATE TRIGGER auth_sessions_metadata_only_insert
BEFORE INSERT ON auth_sessions
WHEN NEW.data IS NOT NULL AND (
  json_type(NEW.data) <> 'object' OR EXISTS (
  SELECT 1 FROM json_each(NEW.data)
  WHERE key NOT IN (
    'folder_id', 'renewed_at', 'email', 'changes_start_page_token', 'client_id',
    'google_sub', 's3_settings_negative_cache_at', 's3_settings_file_id',
    's3_status_file_id', 's3_status_negative_cache_at'
  )
  OR (key IN ('folder_id', 'email', 'changes_start_page_token', 'client_id', 'google_sub', 's3_settings_file_id', 's3_status_file_id') AND type NOT IN ('text', 'null'))
  OR (key IN ('renewed_at', 's3_settings_negative_cache_at', 's3_status_negative_cache_at') AND type NOT IN ('integer', 'real', 'null'))
  )
)
BEGIN
  SELECT RAISE(ABORT, 'auth_sessions.data accepts metadata fields only');
END;

CREATE TRIGGER auth_sessions_metadata_only_update
BEFORE UPDATE OF data ON auth_sessions
WHEN NEW.data IS NOT NULL AND (
  json_type(NEW.data) <> 'object' OR EXISTS (
  SELECT 1 FROM json_each(NEW.data)
  WHERE key NOT IN (
    'folder_id', 'renewed_at', 'email', 'changes_start_page_token', 'client_id',
    'google_sub', 's3_settings_negative_cache_at', 's3_settings_file_id',
    's3_status_file_id', 's3_status_negative_cache_at'
  )
  OR (key IN ('folder_id', 'email', 'changes_start_page_token', 'client_id', 'google_sub', 's3_settings_file_id', 's3_status_file_id') AND type NOT IN ('text', 'null'))
  OR (key IN ('renewed_at', 's3_settings_negative_cache_at', 's3_status_negative_cache_at') AND type NOT IN ('integer', 'real', 'null'))
  )
)
BEGIN
  SELECT RAISE(ABORT, 'auth_sessions.data accepts metadata fields only');
END;
