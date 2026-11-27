-- Older replay records were written before revocation. A redelivery of one
-- of these events must still run the transaction once.
ALTER TABLE risc_processed_events ADD COLUMN completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1));

CREATE TABLE passkey_recovery_grants (
  session_id TEXT PRIMARY KEY,
  subject_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX passkey_recovery_grants_expiry ON passkey_recovery_grants(expires_at);
