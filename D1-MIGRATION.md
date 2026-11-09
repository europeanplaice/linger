# Authentication metadata in D1

## Passkey management verification (migration 0008)

Apply `0008_passkey_management_grants.sql` before deploying the matching Pages
code. Adding or deleting a passkey requires a fresh assertion and a short-lived,
single-use grant bound to the current session. Older Pages code does not enforce
this check, so retire older deployments at rollout.

## Encrypted Google refresh credentials (migration 0007)

Apply `0007_google_refresh_vault.sql` before deploying code that uses the Google
refresh endpoint. The migration adds encrypted refresh-token storage without
modifying existing passkeys or sessions. Existing users must authorize Google
once after the update to obtain a refresh token. Test on staging with a real
Google account, including passkey registration, reload, token refresh, revoked
Google access, account mismatch, and multiple tabs. OAuth projects in Google
Testing status can issue short-lived refresh tokens.

## Passkey metadata protection (migration 0005)

Read [PASSKEY-PRIVACY.md](PASSKEY-PRIVACY.md) before this breaking rollout.
Migration 0005 revokes all old sessions, removes plaintext Google/email/client
columns, enforces NULL session payloads, and adds passkey users, credentials, and
one-use challenges. Google ID and Drive identifiers move to user-key-encrypted
account envelopes; the app requires passkey unlock and Google authorization.
KV-only authentication and legacy raw-session reads are no longer supported.

Rehearse registration, PRF unlock, recovery, existing Drive access, and S3 on
staging before production. Old Google-keyed Durable Objects, KV indexes, logs,
workflow history, and database backups require separate cleanup/retention review.
No production migration or historical cleanup has been performed by adding the
source files. The earlier rollout notes below describe historical versions;
their legacy read/fallback behavior does not apply after migration 0005.

## Earlier credential-removal rollout

OAuth credentials must no longer be persisted. The earlier KV-to-D1 cutover
stored credentials with session metadata. Do not re-enable legacy imports or roll
back to that credential-bearing design.

Read [OAuth privacy and migration](OAUTH-PRIVACY.md) before deployment. The new
flow keeps Google credentials in browser memory and permits backend use only for
an authorized request. D1 and KV session writes project an explicit metadata
allowlist. Session cookies identify metadata, not Drive authorization.

Apply SQL migrations to the matching D1 bindings. **Production prerequisite:**
complete the controlled Google-grant revocation pass in [the cutover procedure](OAUTH-PRIVACY.md)
**before migration 0002**, while legacy live session payloads are still available
in memory. Do not push this change to `main` until that prerequisite is complete: the
production CI job automatically applies pending migrations before deploying.
Staging is a rehearsal and must use staging resources and a dedicated test account. Credential-removal migrations invalidate existing
sessions; users must authorize again. Migrations cannot revoke Google tokens or
erase D1 Time Travel, old KV values, exports, or other historical copies. Retire
old code and pending credential-dependent jobs, remove old KV session records,
and invalidate old Google grants before claiming that historical credentials no
longer grant access. Keep legacy import disabled permanently. Never restore an
old database or deployment as a routine rollback.

Production and staging CI apply migrations before deploying the Worker and Pages.
That order requires database enforcement against credential-bearing writes from
an old instance during the rollout. Rehearse the complete rollout on staging;
the unauthenticated public deployment check alone cannot verify Google sign-in,
diary writes, S3 backup, or credential revocation.

For local development, apply migrations to the shared persistence directory:

```sh
npx wrangler d1 migrations apply AUTH_DB --local --persist-to .wrangler/local-state
```

The Pages and Worker bindings must share one D1 database within each environment.
Production, staging, and preview must use different databases. KV remains needed
for noncredential application caching and progress metadata.

New sessions store a SHA-256 digest of the session cookie instead of the cookie
value. Deploy the Workflows Worker before Pages: an older Worker cannot read
sessions created by the new Pages code. Do not roll the Worker back while the
new Pages version is active. Existing raw-ID sessions remain readable for the
rollout but are no longer extended; they expire at their existing deadline and
may require the user to sign in again. Revoked legacy rows and old pending
deletion or Workflow records can retain raw IDs until their own cleanup. D1
history, backups, logs, and prior Workflow state are not erased by this change.

New OAuth attempts keep their PKCE verifier in a short-lived HttpOnly cookie,
not D1. The one-time state row is deleted atomically on consumption. Expired
unconsumed rows are removed by scheduled cleanup, and historical records remain
subject to the existing backup and retention review.

## Environment bindings

| Environment | Database ID | Worker config |
| --- | --- | --- |
| Production | `9cf1ea9e-9bc5-4fc3-833c-f275a552ad54` | `workers/s3-workflows/wrangler.jsonc` |
| Staging | `151fe69d-7938-41c0-a401-7f2f0a054b76` | `workers/s3-workflows/wrangler.staging.jsonc` |
| Preview | `7ff5f2ac-0dd5-4ad5-8a46-4d689a279300` | `workers/s3-workflows/wrangler.preview.jsonc` |

For each remote environment, use the corresponding config:

```sh
npx wrangler d1 migrations apply AUTH_DB --remote --config workers/s3-workflows/wrangler.staging.jsonc
npx wrangler d1 migrations apply AUTH_DB --remote --config workers/s3-workflows/wrangler.jsonc
npx wrangler d1 migrations apply AUTH_DB --remote --config workers/s3-workflows/wrangler.preview.jsonc
```

Preview's Worker and migrations must be deployed separately before enabling
branch previews. No billing-plan change is required by this source change. Review
current [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) and
[pricing](https://developers.cloudflare.com/d1/platform/pricing/) for the account.

## Validation

```sh
npm run build
npm run lint
npm run test:privacy
npm run test:unit
npm run test:workers
npm test
```

The privacy job is required by both production and staging deployment jobs. It
must fail when credential values reach a persistence boundary; a successful
unauthenticated health check is not a substitute for this requirement.
