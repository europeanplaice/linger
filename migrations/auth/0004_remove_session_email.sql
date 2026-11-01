-- Remove email from both indexed columns and existing live session payloads.
UPDATE auth_sessions SET email = NULL,
  data = CASE WHEN data IS NULL THEN NULL ELSE json_remove(data, '$.email') END;
DROP INDEX IF EXISTS auth_sessions_email;

-- Guard against future writes reintroducing it, including via JSON payloads.
CREATE TRIGGER auth_sessions_no_email_insert BEFORE INSERT ON auth_sessions
WHEN NEW.email IS NOT NULL OR (NEW.data IS NOT NULL AND json_type(NEW.data, '$.email') IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'session email must not be persisted'); END;
CREATE TRIGGER auth_sessions_no_email_update BEFORE UPDATE ON auth_sessions
WHEN NEW.email IS NOT NULL OR (NEW.data IS NOT NULL AND json_type(NEW.data, '$.email') IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'session email must not be persisted'); END;
