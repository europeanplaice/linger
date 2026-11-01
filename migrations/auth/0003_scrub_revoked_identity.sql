-- Revoked sessions only need their opaque ID and expiry as replay tombstones.
UPDATE auth_sessions SET data = NULL, email = NULL, google_sub = NULL, client_id = NULL,
  refresh_owner = NULL, refresh_until = 0
WHERE revoked = 1;
