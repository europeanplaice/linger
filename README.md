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

## Your data

Diary entries are stored as one `.txt` file per day in the `linger_diary/` folder in Google Drive. Short-lived Google tokens accompany authorized requests; the backend uses them transiently without saving them to its databases. By default, reloading requires authorization again. Users can opt to retain the unlocked key in tab session storage for up to eight hours; Google authorization is required again after a reload. The browser keeps a local cache and unsaved drafts so the app can load quickly and recover edits. Google Drive remains the primary copy. See [OAuth privacy and migration](OAUTH-PRIVACY.md) for the security boundary and treatment of previously stored credentials.

S3 backup is optional. It uses short-lived AWS credentials and writes to a bucket in your AWS account. Backup work advances while the app is open and authorized. See the [S3 setup guide](self-hosted/aws-s3/README.md).

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

## Deployment and self-hosting

GitHub Actions validates pull requests to `main` and `staging`. Pushes to those branches deploy production (`linger`) and staging (`linger-staging`); the workflow applies D1 migrations, deploys the Workflows Worker, then deploys Pages and checks the public endpoints.

To deploy your own fork, configure a Google Cloud OAuth web client with the Drive API enabled and your `/auth/callback` URL registered. Provision Cloudflare Pages, D1, KV, and the `s3-workflows` Worker; configure the bindings in the Wrangler files and set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `SESSION_DOMAIN` for both Pages and the Worker. Apply the auth migrations as described in [D1-MIGRATION.md](D1-MIGRATION.md), add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as GitHub Actions secrets, and update the project names and domains in the deployment workflow for your fork.

## Stack

React, TypeScript, and Vite on Cloudflare Pages and Workers. Google Drive stores diary files; D1 stores passkey credentials and encrypted account metadata. Durable Objects coordinate diary writes. Optional S3 backup uses authorized requests while the app is open. Passkey unlock protects Cloudflare metadata; diary files in Drive and S3 stay plaintext. See [passkey privacy and rollout](PASSKEY-PRIVACY.md) for key handling, recovery, and migration requirements.
