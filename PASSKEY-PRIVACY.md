# Passkey-protected Cloudflare metadata

Linger uses a discoverable passkey to identify a random internal account. New
accounts authorize Google first and use the verified email as the passkey label.
Google authorization remains a separate authorization-code flow used to access Drive.
The email label is visible to the browser and passkey provider. Existing passkey
labels are updated where the provider supports WebAuthn's user-details signal.
After successful registration or verified sign-in, this browser remembers a
SHA-256 digest of the normalized email in localStorage to prevent accidental
repeat registration. This hint contains no keys, tokens, or internal account IDs,
is never sent to the server, and remains after sign-out. It is not anonymization:
someone with browser storage access can test a known email against the digest.
Existing accounts acquire this hint on their next verified sign-in. Other browser
profiles, cleared or unavailable storage, and other devices cannot use it.
The explicit lost-all-passkeys recovery flow can bypass the hint after confirmation.
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
Browser keys and plaintext OAuth credentials are memory-only by default. A
passkey-protected refresh token in D1 can restore Google access after unlock.
While another same-origin Linger tab is already unlocked, a newly opened tab
can request the in-memory vault key over `BroadcastChannel` and must verify it
against the active D1 session before unlocking; nothing is written to storage for
tab handoff. If the user explicitly opts in to "Skip passkey on this browser"
(1 or 7 days, fixed expiration, disabled by default), the vault key is encrypted
with AES-256-GCM in a dedicated `linger-device-unlock` IndexedDB database while
the 256-bit wrapping secret is stored only in an `HttpOnly`, `Secure`,
`SameSite=Strict` cookie scoped to `/auth/passkey/device-unlock` and never
stored in D1, KV, Durable Objects, or logs. Signing out, locking the vault,
removing the passkey, or a RISC revocation invalidates the session and blocks
further automatic unlock. Scripts running on the origin can access keys while
unlocked (or request automatic unlock while opted in); users of shared devices
should leave this disabled and explicitly sign out. Legacy key records from
earlier releases in `localStorage`/`sessionStorage` are removed on launch and
never restored. Copies outside live browser storage are not erased by this
cleanup.

## Stored data

- D1 stores an encrypted Google refresh token, random internal account IDs, public passkey credentials, wrapped
  master keys, and opaque hashes of session cookies. Session `data` must be NULL.
- Google ID and cached Drive identifiers are inside an AES-GCM account envelope,
  authenticated against the internal account ID, record purpose, and version.
  Updates merge changed fields using optimistic revision checks.
- DiaryWriter Durable Objects use internal account IDs and encrypt folder IDs,
  per-date file IDs, and create reservations with the user key. New per-date
  storage keys use a keyed digest instead of the date. Legacy date keys are
  migrated on the next authenticated folder operation; historical copies can
  still reveal dates. S3 sync indexes do not retain raw Drive file IDs.
- Request-scoped S3 sync entries use a keyed digest for lookup and encrypt the
  date, versions, state, update time, and error. Legacy entries and failed-date
  lists and job errors migrate when the authenticated sync index is next accessed or an
  authenticated diary operation starts. Until then, or if migration fails,
  the old records remain visible; migration is retried on later operations and
  a failure does not block diary access. Retired durable workflows fail closed rather
  than adding new date-bearing checkpoints; historical workflow payloads and
  steps are not rewritten. Job counts, timestamps, and state remain visible.
  Browser drafts, diary caches, local mirrors, milestones, and sync queues are
  encrypted as described below.
- Keyed lookups still expose the number of entries and repeat access to the same
  lookup key. Dates can also appear in request paths or provider diagnostics;
  account logging and retention settings must be reviewed separately.
- New persistence paths must project fields explicitly; never serialize a whole
  request, auth object, or session object containing keys or credentials.

An operator with only stored data and server configuration cannot decrypt the
protected metadata. An operator or attacker who can inspect request memory or
change the served code can capture a key during use. Public source and deployment
verification help users review the code. During ordinary diary saves and reads, the
browser transfers the body directly to or from Drive. The backend handles Google
credentials and identity and reads diary text for enabled S3 backup or restore
and for compatibility requests from older clients.

## Browser-local encrypted data

Account-scoped drafts, diary caches, local mirrors, milestones, and sync queues
use AES-GCM keys derived from the unlocked master key. New data categories use
distinct HKDF purposes. Keyed identifiers avoid storing their date and email in
cleartext in the encrypted-record index. A separate marker stores a
hash of the normalized email, a vault ID, and the keyed draft group; the email
hash is vulnerable to guessing and the marker and group reveal activity and
record counts. The marker prevents a replacement vault from treating encrypted
local records under a lost key as absent. A marker can be replaced only when
there are no protected records for that account.

Account-owned plaintext drafts migrate after the corresponding Google account
is verified and the passkey vault unlocked. The old record and encrypted copy
are changed atomically in one IndexedDB transaction after checking their versions.
Unowned or conflicting legacy copies are retained for recovery and can remain
plaintext. Owner-tagged diary caches migrate atomically in IndexedDB. Ownerless cached entries, old local mirrors, milestones, and unscoped sync queues
cannot be reliably attributed to an
account; users may explicitly import them into the unlocked account. Unimported,
malformed, or conflicting records remain plaintext. Account-scoped queue items
migrate after an encrypted copy is committed and the source is rechecked. IndexedDB
and localStorage cannot participate in one transaction, so a crash can leave both
copies; importing is safe to retry. Browser backups and old filesystem snapshots
are not securely erased.
Before opening a legacy database at the new schema version, the app asks the user
to save edits and close other Linger tabs. Older releases may close their database
connection on upgrade without notifying their editor, so ignoring that instruction
can leave an old tab unable to save drafts. A blocked upgrade shows a notice and
continues when the blocking connection closes; newer tabs show a warning when
another tab changes the database version.
If all passkeys for the old vault are lost, its encrypted local records cannot
be decrypted. Unsynced drafts and pending changes may be lost; Drive and S3 files
remain accessible separately. Sync requires an unlocked account. Milestone
changes stay encrypted and pending when cross-tab locking is unavailable; Drive
milestone updates remain last-write-wins across different devices.

## Recovery

Settings offers additional passkeys and a list of registered credentials. Users
can remove a lost credential after signing in with another passkey for the same
internal account. Adding or removing a credential requires a fresh passkey
assertion, verified by the server for each operation. The current credential and the final credential are protected
against deletion. Removing a credential also invalidates sessions authenticated
with it. A synced copy of the same credential shares its registration; adding a
separate passkey creates a separately removable registration.

Recovery JSON files are no longer exported or accepted. Possession of a master
key alone cannot create a new authenticated session. Removing a passkey does not
erase previously obtained keys or data, and does not rotate the master key.

If every passkey is lost, register a new internal account/passkey and authorize
the same Google account. Diary files, milestones, and S3 settings stored in Drive
can be loaded again; Cloudflare identity/cache metadata is rebuilt. If this
browser still contains local records protected by the old vault, it refuses to
silently treat them as absent. Use another browser to reconnect without removing
them; clearing this site's data deletes those local records. Local-only preferences
and unsaved drafts are not guaranteed by this process. Keep the
existing OAuth client/project and Drive file grants. If the diary folder was
renamed or automatic discovery cannot identify it, select the existing accessible
Drive folder in settings. This requires continued access to that Google account
and its files, and must be rehearsed with a real Google account before rollout.
After opening the diary with the new passkey, use Settings → Passkeys → Retire
previous accounts’ passkeys. Confirm the linked Google account in the Google
popup. Linger checks the active passkey session and its saved Google connection,
then removes the passkeys, sessions, and saved Google credentials of matching
older Linger accounts. It uses a one-use confirmation bound to the current
session for five minutes. The current account keeps its passkeys and connection.

Older accounts without a blind Google subject index cannot be matched. Secure
a lost device or compromised Google account through Google Account settings.
Revoking Linger's Google access there applies to the whole OAuth project, so
reconnect your current Linger account afterward. An already-issued Google access
token can remain usable until it expires or Google revokes it.

## Google security notifications

When `RISC_INDEX_PEPPER` (32+ characters) is configured, authenticated session
saves record a server-keyed HMAC-SHA-256 digest (`risc_subject_hash`) of the
Google `sub` on `passkey_users` instead of a readable Google identifier. A
verified, supported RISC event with a `sub` then revokes sessions and clears saved
refresh credentials for matching blind-indexed accounts. The handler returns a
retryable error when the secret is missing or an event identifies the account
only by email. D1 commits the SET `jti` digest and the revocation together.
The digest expires after the event's acceptance window.
Users whose sessions are revoked must unlock and authorize again; their passkeys,
keys, and diary files are not deleted.

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
