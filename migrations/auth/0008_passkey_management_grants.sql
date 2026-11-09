-- Short-lived, single-use proof of a fresh passkey assertion for credential management.
CREATE TABLE passkey_management_grants (
  session_id TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK (action IN ('add', 'delete')),
  expires_at INTEGER NOT NULL
);
