# Passkey-protected Cloudflare metadata

Linger uses a discoverable passkey to identify a random internal account. Google
authorization remains a separate authorization-code flow used to access Drive.
Diary files in Drive and the optional S3 backup remain plaintext; this change is
not end-to-end encryption for diary contents.

## Keys and authentication

The browser generates a random 256-bit master key. A passkey's WebAuthn PRF
output, HKDF-SHA-256, and AES-GCM protect that master key. Each credential stores
its own wrapped copy of the same master key. PRF outputs never leave the browser.
The server verifies registration and assertion signatures with SimpleWebAuthn,
requires user verification, and consumes expiring, browser-bound challenges once.
Registration also verifies a PRF assertion before saving a usable credential.

Google Password Manager is a supported choice when the browser/provider supports
PRF. The user creates a passkey for Linger's own domain; a Google-account login
passkey cannot be reused. Other PRF-capable providers are allowed. Unsupported
providers fail closed instead of falling back to plaintext metadata.

The user's master key and Google credentials may be used in request memory.
Authenticated requests send the master key to this origin over HTTPS, together
with the expected internal account ID. These values must never be logged,
persisted, placed in workflow input/output, or retained in server global state.
Browser keys and OAuth credentials are memory-only and cleared on logout/account
invalidation; reloading requires passkey unlock and Google authorization again.

## Stored data

- D1 stores random internal account IDs, public passkey credentials, wrapped
  master keys, and opaque hashes of session cookies. Session `data` must be NULL.
- Google ID and cached Drive identifiers are inside an AES-GCM account envelope,
  authenticated against the internal account ID, record purpose, and version.
  Updates merge changed fields using optimistic revision checks.
- DiaryWriter Durable Objects use internal account IDs and encrypt folder IDs,
  per-date file IDs, and create reservations with the user key. S3 sync indexes
  do not retain raw Drive file IDs.
- Operational metadata such as diary dates, versions, counts, and sync status
  remains visible. Browser diary caches/drafts retain their existing behavior.
- New persistence paths must project fields explicitly; never serialize a whole
  request, auth object, or session object containing keys or credentials.

An operator with only stored data and server configuration cannot decrypt the
protected metadata. An operator or attacker who can inspect request memory or
change the served code can capture a key during use. Public source and deployment
verification help review that risk; they do not eliminate it. The backend still
processes plaintext diary requests and Google identity during authorized operations.

## Recovery

Settings offers another-passkey registration and a user-owned recovery JSON file.
The recovery file contains the internal account ID and master key: anyone holding
it can unlock this account. It is downloaded only on explicit user action and
must be kept private. Import verifies possession by decrypting the account
envelope before creating a session; it does not require a server recovery secret.

If every passkey and recovery file is lost, the old encrypted metadata cannot be
decrypted. The user can instead register a new internal account/passkey and
authorize the same Google account to rediscover existing Drive diary files.
Google ID can be reacquired from verified Google tokens; it is not permanently
lost. This requires continued access to that Google account and its diary files.
Creating a new account does not recover or invalidate the old account's passkeys.

## Google security notifications

There is no persistent Google-sub lookup index. A verified, supported RISC event
therefore conservatively revokes all current Linger sessions. Users must unlock
and authorize again; their passkeys, keys, and diary files are not deleted. This
trades targeted revocation for avoiding a server-readable identity index.

## Rollout

Migration `0005_passkey_vault.sql` revokes existing sessions, erases their identity
metadata, removes Google/email lookup columns, and adds passkey tables. It rejects
subsequent plaintext session payloads. D1 is required; there is no KV-only
authentication fallback. This is a breaking authentication rollout, not a silent
in-place conversion of existing active sessions.

Before production, rehearse on staging with real Google and PRF-capable passkeys:
registration, reload/unlock, account mismatch, two tabs, another passkey,
recovery-file import, new-account recovery from Drive, diary writes, and S3 restore.
Keep the OAuth client/project and existing Drive grants unless a separate
migration verifies that older diary files remain accessible.

The new code and SQL migration do not erase historical D1 Time Travel, exports,
logs, old Google-keyed Durable Objects, KV subject indexes, or workflow history.
Inventory and retire those old objects/indexes and apply the relevant retention
or deletion controls before claiming all historical copies are protected. Freeze
old deployments/jobs throughout the cutover; do not roll back to code that can
write plaintext metadata. The old credential-revocation requirements in
[OAUTH-PRIVACY.md](OAUTH-PRIVACY.md) still apply to any historical credentials.

No production migration, historical deletion, grant revocation, or deployment is
implied by the source changes alone.
