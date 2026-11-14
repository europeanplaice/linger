# Linger

A private daily diary that saves plain-text entries to your Google Drive.

**[Open Linger](https://linger.europeanplaice.com/)** · [Privacy](public/privacy.html) · [Terms](public/terms-of-service.html)

## Features

- Daily writing with autosave, offline drafts, and cross-device edit conflict handling
- Calendar navigation, past-entry recollections, milestones, and public holidays
- Search, revision history, and restore
- ZIP import/export, including a standalone offline viewer
- Themes, fonts, writing prompts, keyboard shortcuts, and mobile support
- Optional S3 backup to a bucket in your own AWS account
- Passkey-protected account metadata and Google authorization

## Your data

Diary entries are stored as one `.txt` file per day in the `linger_diary/` folder in Google Drive. A Google refresh token is encrypted using the passkey-protected key and saved in D1 so Google authorization can be restored after passkey unlock. Short-lived Google tokens accompany authorized requests and are used in memory. The unlocked key is kept in memory; reopening or reloading requires a passkey. New account-scoped drafts, diary caches, local mirrors, milestones, and sync queues are encrypted in browser storage using keys derived from the unlocked passkey-protected key. Account-owned legacy drafts and caches migrate when possible. Unattributed legacy caches, milestones, local mirrors, and old shared sync queues require explicit import; unattributed or conflicting records may remain plaintext for recovery. Some local usage hints, including recently surfaced diary dates, are not encrypted. Google Drive remains the primary copy. See [OAuth privacy and migration](OAUTH-PRIVACY.md) for the security boundary and treatment of previously stored credentials.

S3 backup is optional and requires an AWS account and Terraform setup. AWS verifies your Google identity and issues short-lived credentials for the IAM role you configure; Linger does not need long-lived AWS access keys. It backs up diary entries, not milestones or other settings. Backup work advances while the app is open and authorized. Turning it off does not delete existing objects or versions. See the [S3 setup guide](self-hosted/aws-s3/README.md).

A compatible passkey with WebAuthn PRF support protects the metadata key. If all passkeys are lost, you can create a new Linger account and reconnect to accessible files with the same Google account; old encrypted metadata and local encrypted data, including unsynced drafts and pending changes, cannot be recovered. If old encrypted data remains on this browser, use another browser to continue without deleting it, or clear this site's data only if you accept losing its unsynced data. Diary content is not end-to-end encrypted: the backend processes it during authorized requests, and files in Drive and S3 are plaintext. See the [Privacy Policy](public/privacy.html) for the host administrator's access and the [passkey notes](PASSKEY-PRIVACY.md) for recovery details.

Recovery drafts are saved after a short typing delay; abrupt termination can lose the most recent edits. On the first upgrade from an older storage format, save work and close other Linger tabs before continuing.

## Development

Requires Node.js 26 and npm 12 (see `.nvmrc` and `package.json`).

```bash
npm ci
npm run dev       # UI at http://localhost:5173
```

For local auth and API development, register `http://localhost:8788/auth/callback` with your Google OAuth client, configure the Cloudflare bindings and secrets, then run these in separate terminals:

```bash
npm run dev
npm run workers:dev
npx wrangler dev --config workers/s3-workflows/wrangler.jsonc --persist-to .wrangler/local-state
```

The Pages dev server runs at `http://localhost:8788`. The Workflows Worker is required for diary writes, even when S3 backup is disabled. See [D1 setup](D1-MIGRATION.md) for database migrations.

Useful commands:

```bash
npm run build
npm run ci:local     # build, lint, audit, privacy, unit, Worker, and end-to-end checks
```

### Testing

Put state transitions, validation, and UI branches in Vitest (`tests/unit`). Use
React Testing Library for components and Hooks. For behavior spanning a Hook,
API client, and persistent cache, keep those modules real and replace only HTTP;
`useDiary.integration.test.ts` uses fake-indexeddb this way. Control concurrent
responses with deferred promises and debounce time with fake timers.

Keep Playwright for browser behavior (native input constraints, focus, layout,
reloads, cross-tab messaging) and representative App journeys. SearchBar's branch
coverage runs in Vitest; Playwright checks native length enforcement and selecting
a search result in the App. When moving a case, verify its replacement before
removing the browser test.

```bash
npm run test:unit -- tests/unit/searchBar.test.tsx tests/unit/useDiary.integration.test.ts
npm test -- tests/searchBar.test.ts tests/useDiary.test.ts --project=chromium
```

## Deployment and self-hosting

GitHub Actions validates pull requests to `main` and `staging`. Pushes to those branches deploy production (`linger`) and staging (`linger-staging`); the workflow applies D1 migrations, deploys the Workflows Worker, then deploys Pages and checks the public endpoints.

The E2E job resolves its official Playwright container from the exact version in
`package-lock.json` and verifies the registry manifest's SHA256 before using it.
Dependency updates automatically select the matching container; no image version
or digest needs to be updated by hand. An unavailable image fails the preparation
job before browser tests start. Run `npm run test:ci` to check the resolver locally.

To deploy your own fork, configure a Google Cloud OAuth web client with the Drive API enabled and your `/auth/callback` URL registered. Provision Cloudflare Pages, D1, KV, and the `s3-workflows` Worker; configure the bindings in the Wrangler files and set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `SESSION_DOMAIN` for both Pages and the Worker. Apply the auth migrations as described in [D1-MIGRATION.md](D1-MIGRATION.md), add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as GitHub Actions secrets, and update the project names and domains in the deployment workflow for your fork.

## Stack

React, TypeScript, and Vite on Cloudflare Pages and Workers. Google Drive stores diary files; D1 stores passkey credentials and encrypted account metadata. Durable Objects coordinate diary writes. Optional S3 backup uses authorized requests while the app is open. Passkey unlock protects Cloudflare metadata; diary files in Drive and S3 stay plaintext. See [passkey privacy and rollout](PASSKEY-PRIVACY.md) for key handling, recovery, and migration requirements.
