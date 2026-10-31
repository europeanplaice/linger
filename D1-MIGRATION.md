# Authentication storage: KV to D1

The implementation and local tests are ready. **No remote D1 database has been
created, no existing session data has been changed, and this migration has not
been deployed.** UUIDs starting with `00000000-0000-0000-0000-` in Wrangler configs
are local placeholders. Replace them before any deployment; the CI migration
step will fail for an unprovisioned database before deploying application code.

## Free-tier use

D1 supports Workers Free without upgrading the account. Its daily allowance is
5 million rows read and 100,000 rows written; index writes count too. Free accounts
have a 500 MB per-database limit and up to 10 databases. This setup uses three
separate databases (production, staging, preview), with indexes on the session ID,
identities, and expiry. An existing account's other databases/usage share its limits.

On Workers Free, exceeding the allowance stops D1 queries until the daily reset;
it does not automatically upgrade the plan. On an already-paid account, excess
usage can incur charges. This work does not change subscriptions or enable billing.
The available API token could not read account subscriptions or access D1, so the
account's actual plan, remaining allowance, and resource count are unverified.

Sources: [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/),
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

## Provision and activate later

1. Grant the deployment/Terraform token **Account → D1 → Edit**, scoped to the
   existing Linger account. Retain its existing Pages, Workers Scripts, and KV
   permissions. No paid-plan upgrade is required.
2. Review `terraform -chdir=infra plan`. The D1 additions in `infra/d1.tf` create
   `linger-auth-production`, `linger-auth-staging`, and `linger-auth-preview` and
   attach the right database to each Pages environment. Apply only when ready to
   activate; review any unrelated drift separately. D1 resources have
   `prevent_destroy`. Terraform manages resources, while Wrangler manages SQL.
3. Copy `terraform -chdir=infra output auth_database_ids` into the matching configs:

   | Environment | Pages | Worker |
   | --- | --- | --- |
   | Production | `wrangler.toml`, top-level `AUTH_DB` | `workers/s3-workflows/wrangler.jsonc` |
   | Staging | `wrangler.staging.toml` | `workers/s3-workflows/wrangler.staging.jsonc` |
   | Preview | `wrangler.toml`, `env.preview` | `workers/s3-workflows/wrangler.preview.jsonc` |

   Pages and its diary/backup Worker must share one D1 database **within** an
   environment. Different environments must have different databases. Keep the
   legacy KV namespace bindings as they are.
4. Set the same `AUTH_KV_FALLBACK_UNTIL` UTC timestamp in Pages and its Worker for
   each environment. Choose at least 31 days after the **last deployment still
   writing sessions to KV**, including any rollback. The checked-in value is
   empty, which disables import. For a new installation without legacy sessions,
   leave it empty. Do not extend this window indefinitely. Also set the matching
   `AUTH_KV_REVOCATION_CHECK_UNTIL` to a short cutover window (for example, 30 minutes
   after the deployment starts). During that window D1 authentication checks KV
   revocation markers too, so logout/RISC requests reaching an old Pages version
   still invalidate sessions already imported by the new Worker. Once it expires,
   ordinary D1 requests stop accessing KV. Extend this short window if the old
   version remains live longer; finish the Worker/Pages rollout before it ends.
5. Apply migrations before deploying any D1-enabled code:

   ```sh
   npx wrangler d1 migrations apply AUTH_DB --remote --config workers/s3-workflows/wrangler.staging.jsonc
   npx wrangler d1 migrations apply AUTH_DB --remote --config workers/s3-workflows/wrangler.jsonc
   npx wrangler d1 migrations apply AUTH_DB --remote --config workers/s3-workflows/wrangler.preview.jsonc
   ```

   Production and staging CI perform the matching migration before deploying the
   Worker, then Pages. Rehearse on staging first. During the initial Worker/Pages
   cutover, keep the short KV revocation-check window active until both versions
   have switched. Old code cannot see sessions created only in D1, so avoid a
   prolonged mixed-version rollout. Once both sides use D1, primary reads and
   conditional updates coordinate revocation.
   Preview's Worker/migrations are deployed manually as before; ensure both are
   ready before enabling branch previews.
6. Verify sign-in, reading/saving an entry, two tabs, logout, and Google account
   switching on staging, then production. The public deployment health check
   does not exercise authenticated Google operations. Reverting to KV-only code
   cannot retain sessions created only in D1; prefer a D1-compatible rollback.

## What moves and how

- `auth_sessions` holds credentials and metadata together with indexed email,
  Google subject, OAuth client, expiry, and refresh-lease fields. A fresh login
  creates the row and indexes atomically. Ordinary saves update existing live
  rows only and cannot overwrite OAuth token fields.
- OAuth state/PKCE data moves to `auth_oauth_states`. An atomic update consumes
  it once even if callbacks arrive concurrently. A consumed row remains until
  expiry to prevent replay from a still-readable legacy KV value.
- Token refresh uses a 90-second database lease, ownership-checked completion,
  and 15-second timeouts per Google token request. Waiters have a bounded wait
  and return a retryable failure if the refresh is still running. Database
  transactions are never held over external API calls.
- Logout clears credentials and leaves a temporary tombstone. RISC revokes rows
  by indexed identity. During the import window it also revokes legacy KV
  sessions that have not yet visited D1. A delayed update cannot recreate a
  deleted or revoked D1 session.
- On a D1 miss during the import window, the existing KV value and revocation
  marker are checked and the row is imported insert-only with the original KV
  expiry. The existing cookie stays valid. Once imported, normal authentication
  uses D1 without KV after the short cutover window. A D1 failure never authorizes from KV as a fallback.
- The existing `s3-workflows` Worker runs hourly cleanup, deleting at most 500
  expired session rows and 500 expired OAuth-state rows per run. Expiry is checked
  on every auth read even if cleanup has not run. Revocation tombstones outlive
  the migration deadline before cleanup can remove them.
- KV remains for public holiday caching and bounded legacy compatibility. Diary
  bodies remain in Drive. No credentials or diary bodies are exported to a local
  migration file.

After the migration deadline, legacy fallback stops automatically. The KV-only
compatibility path is retained for older/local installations without `AUTH_DB`;
all configured application environments bind D1. Keep the KV namespace because
holiday caching still uses it. Monitor D1 row reads/writes, database size, query
latency, refresh failures, and expiry-cleanup backlog.

## Local development and checks

Apply the migration to the same local persistence directory used by both dev
processes before signing in:

```sh
npx wrangler d1 migrations apply AUTH_DB --local --persist-to .wrangler/local-state
```

The root Pages and production Worker configs use the same local placeholder UUID,
so their D1 bindings share storage when both use that persistence directory.
Workers tests create isolated local D1 databases and apply the SQL migrations
automatically. Existing KV unit tests also exercise the compatibility path.

```sh
npm run build
npm run lint
npm run test:unit
npm run test:workers
npm test
terraform -chdir=infra validate
```
