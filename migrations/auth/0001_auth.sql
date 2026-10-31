-- Authentication reads deliberately use the primary (not read replicas).
CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY,
  data TEXT,
  email TEXT,
  google_sub TEXT,
  client_id TEXT,
  expires_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  refresh_owner TEXT,
  refresh_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX auth_sessions_email ON auth_sessions(email, revoked, expires_at);
CREATE INDEX auth_sessions_sub ON auth_sessions(google_sub, revoked, expires_at);
CREATE INDEX auth_sessions_expiry ON auth_sessions(expires_at);

CREATE TABLE auth_oauth_states (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX auth_oauth_states_expiry ON auth_oauth_states(expires_at);
