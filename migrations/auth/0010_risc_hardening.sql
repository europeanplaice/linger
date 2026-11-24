-- Blind RISC subject index (keyed with RISC_INDEX_PEPPER), single-use SET replay
-- tracking, privacy-preserving auth rate-limit buckets, and grant expiry index.
ALTER TABLE passkey_users ADD COLUMN risc_subject_hash TEXT CHECK (
  risc_subject_hash IS NULL OR (
    substr(risc_subject_hash, 1, 12) = 'hmac-sha256:' AND
    length(risc_subject_hash) = 76 AND
    substr(risc_subject_hash, 13) NOT GLOB '*[^0-9a-f]*'
  )
);
CREATE INDEX passkey_users_risc_subject_hash ON passkey_users(risc_subject_hash);

CREATE TABLE risc_processed_events (
  jti_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX risc_processed_events_expiry ON risc_processed_events(expires_at);

CREATE TABLE auth_rate_limits (
  bucket_key TEXT PRIMARY KEY,
  count INTEGER NOT NULL CHECK (count > 0),
  expires_at INTEGER NOT NULL
);
CREATE INDEX auth_rate_limits_expiry ON auth_rate_limits(expires_at);

CREATE INDEX passkey_management_grants_expiry ON passkey_management_grants(expires_at);
