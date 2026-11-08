-- Passkeys become the only Cloudflare account identifier. Revoke every session
-- created under Google-sub lookup and erase its previously stored identifiers.
UPDATE auth_sessions
SET data = NULL,
    email = NULL,
    google_sub = NULL,
    client_id = NULL,
    revoked = 1,
    refresh_owner = NULL,
    refresh_until = 0,
    expires_at = MAX(expires_at, CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 2592000000);

DROP INDEX IF EXISTS auth_sessions_sub;
DROP INDEX IF EXISTS auth_sessions_email;
ALTER TABLE auth_sessions ADD COLUMN user_id TEXT;
CREATE INDEX auth_sessions_user_id ON auth_sessions(user_id, revoked, expires_at);

-- Session JSON is no longer a persistence surface. OAuth credentials and
-- request-local identity metadata must never be serialized into D1.
DROP TRIGGER IF EXISTS auth_sessions_metadata_only_insert;
DROP TRIGGER IF EXISTS auth_sessions_metadata_only_update;
DROP TRIGGER IF EXISTS auth_sessions_no_email_insert;
DROP TRIGGER IF EXISTS auth_sessions_no_email_update;
ALTER TABLE auth_sessions DROP COLUMN google_sub;
ALTER TABLE auth_sessions DROP COLUMN email;
ALTER TABLE auth_sessions DROP COLUMN client_id;
CREATE TRIGGER auth_sessions_no_data_insert BEFORE INSERT ON auth_sessions
WHEN NEW.data IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'passkey sessions cannot persist identity data'); END;
CREATE TRIGGER auth_sessions_no_data_update BEFORE UPDATE ON auth_sessions
WHEN NEW.data IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'passkey sessions cannot persist identity data'); END;

CREATE TABLE passkey_users (
  id TEXT PRIMARY KEY,
  account_envelope TEXT CHECK (
    account_envelope IS NULL OR (
      substr(account_envelope, 1, 3) = 'v1.' AND
      length(account_envelope) >= 40 AND
      length(account_envelope) - length(replace(account_envelope, '.', '')) = 2 AND
      account_envelope NOT GLOB '*[^A-Za-z0-9_.-]*'
    )
  ),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at INTEGER NOT NULL
);

CREATE TABLE passkey_credentials (
  credential_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES passkey_users(id) ON DELETE CASCADE,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0 CHECK (counter >= 0),
  transports TEXT NOT NULL DEFAULT '[]',
  prf_salt TEXT NOT NULL,
  wrapped_master_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX passkey_credentials_user_id ON passkey_credentials(user_id);

-- The random cookie secret is hashed into id and bound to a one-use challenge.
-- No Google identifier or PRF output is present in this table.
CREATE TABLE passkey_challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  wrap_challenge TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('register', 'login', 'add')),
  user_id TEXT,
  prf_salt TEXT,
  expires_at INTEGER NOT NULL
);
CREATE INDEX passkey_challenges_expiry ON passkey_challenges(expires_at);

-- In-flight OAuth state does not survive this auth model cutover.
DELETE FROM auth_oauth_states;
