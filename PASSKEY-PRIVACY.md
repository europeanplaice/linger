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
persisted on the server, placed in workflow input/output, or retained in server global state.
By default browser keys and OAuth credentials are memory-only. Users can opt in
to saving the unlocked key in the tab's sessionStorage
for reloads, for at most eight hours. Google authorization is required again after a reload. This exposes the key to scripts running in the
origin and anyone with access to that browser profile. Sign-out, account changes,
expiry and failed session validation clear the saved state. Browser restore behavior
can retain tab state, so users of shared devices should explicitly sign out.

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

Settings offers additional passkeys and a list of registered credentials. Users
can remove a lost credential after signing in with another passkey for the same
internal account. The current credential and the final credential are protected
against deletion. Removing a credential also invalidates sessions authenticated
with it. A synced copy of the same credential shares its registration; adding a
separate passkey creates a separately removable registration.

Recovery JSON files are no longer exported or accepted. Possession of a master
key alone cannot create a new authenticated session. Removing a passkey does not
erase previously obtained keys or data, and does not rotate the master key.

If every passkey is lost, register a new internal account/passkey and authorize
the same Google account. Diary files, milestones, and S3 settings stored in Drive
can be loaded again; Cloudflare identity/cache metadata is rebuilt. Local-only
preferences and unsaved drafts are not guaranteed by this process. Keep the
existing OAuth client/project and Drive file grants. If the diary folder was
renamed or automatic discovery cannot identify it, select the existing accessible
Drive folder in settings. This requires continued access to that Google account
and its files, and must be rehearsed with a real Google account before rollout.
Creating a new account does not invalidate the old account's passkeys. Without
another passkey for that old internal account, it cannot be managed from the new
one; a lost Google session/device must also be secured through Google.

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
in-place conversion of existing active sessions. The follow-up credential-session
migration associates new sessions with the authenticating credential and revokes
older sessions that cannot be attributed to a credential.

Before production, rehearse on staging with real Google and PRF-capable passkeys:
registration, reload/unlock, account mismatch, two tabs, another passkey,
credential removal and session revocation, new-account recovery from Drive
(including renamed folders), diary writes, and S3 restore.
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
