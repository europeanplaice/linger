-- Bind passkey sessions to the credential that authenticated them. Revoke
-- sessions from before this migration because their credential cannot be known.
ALTER TABLE auth_sessions ADD COLUMN credential_id TEXT;
CREATE INDEX auth_sessions_credential_id ON auth_sessions(credential_id, user_id, revoked);
UPDATE auth_sessions
SET user_id = NULL, credential_id = NULL, data = NULL, revoked = 1
WHERE user_id IS NOT NULL;
