-- Only authenticated ciphertext is persisted; the vault key is request-local.
CREATE TABLE google_refresh_vault (
  user_id TEXT PRIMARY KEY REFERENCES passkey_users(id) ON DELETE CASCADE,
  envelope TEXT NOT NULL CHECK (substr(envelope, 1, 3) = 'v1.'),
  updated_at INTEGER NOT NULL
);
