-- Labels are encrypted with the unlocked vault key and credential-bound AAD.
-- Usage times contain no Google identity or device information.
ALTER TABLE passkey_credentials ADD COLUMN name_envelope TEXT CHECK (
  name_envelope IS NULL OR (
    substr(name_envelope, 1, 3) = 'v1.' AND length(name_envelope) >= 40 AND
    length(name_envelope) - length(replace(name_envelope, '.', '')) = 2 AND
    name_envelope NOT GLOB '*[^A-Za-z0-9_.-]*'
  )
);
ALTER TABLE passkey_credentials ADD COLUMN last_used_at INTEGER;
