# Linger — Google Drive Diary

A minimalist personal diary app. Entries are stored as plain-text files in your own Google Drive.

**[-> Open the app](https://linger.europeanplaice.com/)**

## Features

- Write daily diary entries, with manual save via button or Ctrl/Cmd+S
- Optional Drive auto-save after a few seconds of editing
- Calendar view to navigate by date, with dots marking days that have entries
- Recollection Journey — a serendipity view that surfaces "on this day" past entries and random older ones
- Previous/next day controls, plus Alt+Left / Alt+Right and Alt+Up for today
- Keyboard shortcuts for save, day navigation, search focus, theme, and font toggles
- Full-text search via Drive API, with on-demand snippet extraction from matched entries
- Delete entries with an explicit confirmation step
- Detect cross-device edit conflicts and choose whether to load latest, keep local edits, or overwrite
- View and restore past revisions of an entry
- Export all entries as a ZIP of plain-text files, plus a self-contained, searchable `index.html` viewer for offline browsing
- Import entries and milestones from a ZIP — either the app's own export or a folder downloaded directly from Drive
- Settings modal for theme (light / dark / system), accent color, font family, font size, auto-save, language (English / Japanese), export/import, and sharing the app URL
- Data stays in your Google Drive (`linger_diary/` folder), one plain-text file per day
- Warns before reload or date changes when there are unsaved edits; unsynced edits are kept as local drafts and offline deletes are queued, both retried automatically once the connection returns
- Multiple tabs of the app stay in sync with each other via `BroadcastChannel`
- Works on mobile with a drawer sidebar, Android back-button support, and keyboard-aware layout
- Milestone management with badges on the calendar (up to 50 milestones, 5 with display badges, fully customizable emoji)
- Public holiday overlay on the calendar, customizable by country
- Touch swipe navigation between days on mobile
- Share individual entries or share the app URL
- Installable as a Progressive Web App
- Contextual writing prompts — a static bank plus dynamic prompts fed by your cadence, milestones, holidays, seasons and the topics you write about (see `src/data/writingPrompts.ts`, `src/utils/dynamicPrompts.ts`)
- Local TF-IDF search over your cached corpus, powering "similar past entries" and topic signals (see `src/utils/tfidf.ts`, `src/hooks/useTfIdfSearch.ts`)
- Optional **S3 mirror/backup** — mirror entries to an S3 bucket in your own AWS account using short-lived credentials assumed from your Google sign-in, with resumable backfills, per-entry mirroring, and restore-from-backup (see "S3 mirror / self-hosted backup" below)
- `?` opens a keyboard-shortcuts reference modal

## How it works

### Auth flow
Uses **OAuth 2.0 Authorization Code Flow with PKCE** via Cloudflare Pages Functions:

1. Clicking "Sign in with Google" redirects to `/auth/login`, which generates a PKCE code verifier,
   stores it in Cloudflare D1 (5-minute lifetime), and redirects to Google's OAuth consent screen.
2. Google redirects back to `/auth/callback` with an authorization code.
3. The callback handler exchanges the code for access + refresh tokens (server-side, never exposed
   to the browser), stores the session in Cloudflare D1 (30-day sliding lifetime), and sets an `HttpOnly`
   `Secure` `SameSite=Strict` session cookie (`linger_session`).
4. Subsequent requests include the session cookie; the Cloudflare middleware resolves the session,
   refreshes the access token if needed, and proxies the Drive API call.

Drive scope: `drive.file` — non-sensitive, only accesses files this app created.
The login flow also requests `openid email` so the app can identify the signed-in account and clear local cache on account switches.

`/auth/risc` receives Google [RISC](https://developers.google.com/identity/protocols/risc) Security Event Tokens (session/token revocation, account disabled, credential change) and revokes sessions by Google subject and email server-side.

Authentication uses primary D1 reads, indexed identity lookups, atomic OAuth-state
consumption, and a database lease to coordinate token refresh across Worker
instances. Metadata saves cannot overwrite refreshed tokens, and revoked sessions
cannot be recreated by a delayed update. The existing Workflows Worker removes
expired rows hourly in bounded batches; authorization checks expiry immediately.

Existing KV sessions can be imported on first access without changing their cookie
or extending their original expiry. `AUTH_KV_FALLBACK_UNTIL` bounds this transition;
normal D1 requests do not access KV. The `SESSIONS` KV binding remains for public
holiday caching and migration compatibility. See [D1 migration and activation](D1-MIGRATION.md)
before deploying: database IDs in the committed configs are local placeholders
until the remote databases have been provisioned.

### Drive storage
All Drive API v3 calls are made server-side by Cloudflare Pages Functions at `/api/drive/…`.
The browser never holds an OAuth token. Diary entries are stored as individual plain-text files (MIME `text/plain`):

```
/linger_diary/
  diary-YYYY-MM-DD.txt   ← plain-text body
  milestones.json        ← milestone list (JSON array)
```

New entries are written as `.txt`. Legacy `.md` files remain readable and are renamed to `.txt` by a one-time migration on first sign-in.
Milestones are read from `milestones.json`, falling back to the legacy `anniversaries.json` name if present.

The folder name is environment-dependent: `linger_diary` in production, `linger_diary_staging` on the `staging.*` host, and `linger_diary_dev` for local dev hostnames (`localhost`/`127.0.0.1`) — see `src/utils/folderName.ts`. This keeps dev/staging/production diary data fully separated even when signed in with the same Google account.

Current `.txt` files contain only the entry body:

```text
Entry content here...
```

Legacy files that still contain YAML frontmatter are also readable; the frontmatter is stripped on load and the date from the filename remains authoritative.

Folder ID is cached in the D1 session record after first lookup.
File upload uses multipart/related to set both metadata and content in one request.
Drive 429/5xx responses are retried with exponential backoff.

Diary saves, deletes, and S3 restores pass through an account-scoped `DiaryWriter`
Durable Object in the existing `s3-workflows` Worker. It serializes the version
check and write across tabs, devices, and login sessions. New files use a
Drive-generated ID reserved in durable storage before creation, so an ambiguous
timeout can retry without creating another file for the same date. The object
stores folder/file IDs only; diary text remains in Drive and the browser cache.
This coordination covers Linger writes; edits made directly through other Drive
clients do not participate in its queue.

Deleting an entry requires the file ID and version displayed when its confirmation
dialog opened. If either changed, the server returns a conflict and preserves the
entry. Offline delete reservations retain those preconditions; stale reservations
and legacy reservations without them are cancelled with a notice. User deletions
move the Drive file to the trash, where it can be recovered under Drive's normal
retention policy.

### State
- `useAuth` (`src/hooks/useAuth.ts`) — calls `/auth/session` on load to check sign-in state;
  exposes `{ status, tokenExpired, hadSession, email, googleSub, googleClientId, authError, clearAuthError, signIn, signOut, handleExpired, retryAfterExpired }`
  (`googleSub` is the user's numeric Google account ID and `googleClientId` the OAuth client — both shown in Settings under the S3 connection; `authError` can be `'no_refresh_token'`)
- `useDiary` (`src/hooks/useDiary.ts`) — on sign-in, calls `listEntries` via the `/api/drive/…`
  proxy; lazily fetches content per entry into a `Map<date, EntryCache>`;
  hydrates recent entry metadata/content from IndexedDB, syncs Drive changes incrementally, prefetches likely next entries,
  and exposes `{ loading, freshListLoaded, error, dates, hasLegacyMdFiles, getContent, save, remove, search, refreshEntries, prefetch, retryPendingSave, exportAll, importAll }`

### Browser storage
The browser stores only non-sensitive preferences and small UI hints in `localStorage`:
- `linger_autosave` — whether auto-save is enabled
- `linger_theme` — `light` / `dark` / `system`
- `linger_accent` — accent color preference (`indigo` / `sage` / `terracotta`)
- `linger_font` — font preference
- `linger_fontsize` — font size (`sm` / `md` / `lg` / `xl`)
- `linger_language` — `en` / `ja`
- `linger_holiday_country` — holiday calendar country selection
- `linger_milestones` — local cache of the milestone list (JSON array), synced to Drive
- `linger_milestones_pending` — flag indicating a milestone save is pending Drive sync
- `linger_had_session` — `true`/`false` flag indicating whether the user was previously signed in (used to show the "continue with your previous session" prompt on the login screen)
- `linger_session_user` — last signed-in email; used to detect cross-device account switches and clear stale cached data
- `linger_ext_migrated` — one-time flag set after the `.md` → `.txt` file-extension migration runs
- `linger_serendipity_seen` — recently surfaced Recollection Journey dates, stored as dates only to avoid immediate repeats
- `gp-save-timings` — recent save durations (up to 10 samples) used to animate the save progress bar
- `linger_local_entry_<date>` / `linger_local_entries_index` — a local mirror of saved entry content, written by `LocalStorageAdapter` (`src/lib/storageAdapter.ts`) on every save/delete
- `linger_pending_sync_queue` — durable queue of offline deletes awaiting replay against Drive, managed by `SyncQueueManager` (`src/lib/syncQueue.ts`)

Both the local entry mirror and the sync queue are wiped on sign-out and account switch (`src/hooks/useDiary.ts`), same as the IndexedDB cache below.

Diary metadata, recently opened entry content, and snippets are cached in IndexedDB (`linger_diary_cache`) so the sidebar and recent entries can render quickly before the Drive network round trip completes. The same database also holds drafts — unsaved edits that failed to reach Drive (offline or a dropped request) — which are replayed automatically once the connection returns or the tab regains focus. The cache is scoped to the last signed-in email and is cleared on sign-out or account switch.

Open tabs are kept in sync with each other via a `BroadcastChannel` (`linger_tab_sync`, `src/utils/tabSync.ts`): saving, deleting, or editing milestones in one tab refreshes the others.

No OAuth tokens are exposed to the browser or written to browser storage. Diary content is written to `localStorage` only as the local mirror described above (Drive remains the source of truth); it is cleared on sign-out and account switch.

### Components
- `Landing` — signed-out landing page with marketing content, privacy info, and the `LoginScreen` sign-in card
- `LoginScreen` — sign-in card with Google auth button
- `App` — sidebar + main panel layout
- `AppIcon` — app logo SVG used in the sidebar header
- `CalendarView` — monthly grid built with native `Date` arithmetic; dots on dates with entries, milestone and holiday badges
- `EntryEditor` — `<textarea>`, save/delete; Ctrl+S triggers save; handles conflict resolution; day navigation; swipe navigation; milestone/holiday badges; revision history access; share entry
- `EmojiPicker` — full Unicode emoji picker (grouped by category) used in milestone settings
- `SearchBar` — full-text search via Drive API; fetches and caches entry content for snippet extraction
- `RecollectionJourney` — modal dialog surfacing "on this day" past entries and random serendipity entries
- `SettingsModal` — language, theme, accent color, font family/size, auto-save, holiday calendar, milestone management, export/import, app sharing, keyboard shortcuts, data-storage links, and legal links
- `SessionExpiredModal` — prompts re-auth when the session expires and retries the pending save
- `HistoryModal` — view and restore past Drive revisions of an entry
- `KeyboardShortcutsModal` — keyboard-shortcut reference, opened by pressing `?`
- `ExportButton` — ZIP export UI used inside `SettingsModal`; bundles plain-text entries plus a portable `index.html` viewer
- `ImportButton` — ZIP import UI used inside `SettingsModal`; reads the app's own export format or a raw `linger_diary` folder downloaded from Drive, including milestones
- `MilestoneFormModal` — add/edit milestone form modal; used inside `SettingsModal` and `EntryEditor`
- `SettingsSelect` — reusable styled select used inside `SettingsModal`
- `ErrorBoundary` — catches render errors and displays a fallback UI
- `useServiceWorkerUpdate` — applies waiting PWA updates when the tab is hidden and the current entry is not dirty

### Analytics
The app uses **Cloudflare Web Analytics** — cookie-free, no individual tracking, no personal data collected. It captures aggregated page views, referrers, country, device/browser, and Core Web Vitals. Data is retained by Cloudflare for 6 months.

### Deployment
The app is deployed to **Cloudflare Pages** via GitHub Actions (see `.github/workflows/deploy.yml`).
The workflow runs lint, unit tests, the S3 Worker's test suite, Playwright e2e tests, and `npm audit`, then deploys with `wrangler pages deploy`.
The same job applies D1 authentication migrations, then deploys the `s3-workflows` Worker (`workers/s3-workflows/`) with `wrangler deploy`.
The Worker is deployed before Pages so the new diary RPC methods and Durable
Object migrations are available before the frontend/API starts calling them.
The `DIARY_WRITER` binding and `v2` SQLite migration are declared for production,
staging, and preview; Wrangler applies the migration on deployment.

After both deployments, CI checks the custom domain: the Linger HTML page returns 200, `/auth/session` returns signed-out JSON with 200, and `/api/drive/entries` returns an unauthenticated JSON 401. It also checks that `/sw.js` is JavaScript and requires cache revalidation without a positive cache TTL. Requests have a 10-second timeout; the checks retry up to six times with five seconds between attempts, then fail the deployment job. Run them manually with `node scripts/check-deployment.mjs https://linger.europeanplaice.com` (or the staging URL). These checks cover public routing and authentication rejection, not signed-in Drive operations or the backup Worker's execution.

`public/_headers` sets `/sw.js` to `no-cache, no-store, must-revalidate`: the custom domain was observed rewriting bare `no-cache` to a four-hour browser TTL while the Pages domain preserved it. Keep `no-store` to prevent storing the update script, and use the deployment check to catch any further edge overrides. This does not disable the service worker's own offline caches.

Pull requests targeting `main` or `staging` run the build and the same lint, test, and audit checks. Deployments run only on pushes to those branches. A separate weekly dependency audit (`.github/workflows/dependency-audit.yml`) checks for newly disclosed vulnerabilities even when no code changes. Dependabot checks npm packages and GitHub Actions weekly and opens update pull requests.

Some Cloudflare test dependencies pin older transitive packages. The `package.json` overrides keep Sharp, Undici (within each major version), and the test plugin's Zod on patched releases. Recheck these overrides and the version-specific `allowScripts` entries when upgrading `@cloudflare/vitest-plugin` or Wrangler. TypeScript is constrained to `~6.0.3` because `typescript-eslint` requires `<6.1.0`; defer TypeScript 7 until it is supported. Vitest 5 requires Node.js 22.12+ (CI uses Node.js 22).

Pushes to `main` deploy to the production Pages project (`linger`) and the production `linger-s3-workflows` Worker; pushes to `staging` deploy to a separate `linger-staging` Pages project on `staging.linger.europeanplaice.com` and the `linger-s3-workflows-staging` Worker, used to rehearse OAuth branding/consent-screen changes without risking the production app's verified status. Both environments' surrounding Cloudflare resources (D1 databases, KV namespaces, Pages projects, DNS) are managed via Terraform in `infra/` — Terraform no longer owns the Worker script or its Workflow bindings, since CI can't run `terraform apply` (local-only state, no remote backend).

Cloudflare's own Pages Git integration auto-builds a preview deployment for every other branch/PR, backed by a third `linger-s3-workflows-preview` Worker. CI doesn't deploy that one (it only triggers on `main`/`staging` pushes) — deploy it by hand when its code needs to catch up:
```bash
npx wrangler deploy workers/s3-workflows/src/index.ts --config workers/s3-workflows/wrangler.preview.jsonc
```

`vite.config.ts` uses `base: '/'` (correct for a custom domain).

### S3 mirror / self-hosted backup

Alongside Google Drive, you can optionally mirror entries to an **S3 bucket in your own AWS account** — a redundant backup/export target independent of Linger. AWS has no consumer OAuth consent screen, so Linger never holds long-lived AWS credentials: at request time the server exchanges your existing Google sign-in `id_token` for short-lived AWS credentials via `sts:AssumeRoleWithWebIdentity`. The role's IAM trust policy is scoped by both `accounts.google.com:aud` (Linger's OAuth client ID) and `accounts.google.com:sub` (your personal numeric Google account ID), so only your own session can assume it.

The trust relationship is set up **once in your own AWS account** with the standalone Terraform module in `self-hosted/aws-s3/` (IAM OIDC provider + role + a versioned, encryption-enabled, fully private bucket). `terraform apply` prints the `role_arn`/`bucket_name` to paste into Settings under **S3 backup**, where you can test the connection, run an initial backfill, retry failed entries, resync everything, restore entries missing from Drive, and watch per-entry sync status (`synced` / `pending` / `failed` / `unconfirmed` / `backfilling`). Revocation is `terraform destroy` — bucket contents and the bucket itself (`prevent_destroy`) are untouched.

S3 access flows through the Pages Functions at `/api/s3/…` and a dedicated Worker reached via the `S3_WORKFLOW_SERVICE` service binding (`workers/s3-workflows/`). Heavy operations run as **Cloudflare Workflows** (durable, resumable backfills in chained chunks and per-save mirrors) coordinated by a `S3SyncIndex` Durable Object that tracks per-date sync state. The full user-facing setup guide mirrors `public/self-hosted-s3.html` and the module's `README.md`.

## Self-hosting

### 1. Fork this repository

### 2. Set up a Google Cloud project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project and enable the **Google Drive API**
3. Go to **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**
4. Application type: **Web application**
5. Add your production origin and redirect URI:
   - **Authorized JavaScript origins**: `https://<your-domain>`
   - **Authorized redirect URIs**: `https://<your-domain>/auth/callback`
6. Copy the **Client ID** and **Client Secret**

### 3. Set up Cloudflare Pages

1. Create a [Cloudflare](https://cloudflare.com/) account if you don't have one
2. Create a **KV namespace** for public holiday caching and legacy session migration:
   ```
   wrangler kv namespace create SESSIONS
   wrangler kv namespace create SESSIONS --preview
   ```
3. Copy `wrangler.toml.example` to `wrangler.toml`, fill in the KV namespace IDs, and provision/bind D1 using [D1-MIGRATION.md](D1-MIGRATION.md)
4. Add the following secrets via the Cloudflare dashboard or `wrangler pages secret put`:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `SESSION_DOMAIN` (e.g. `https://your-domain.com`)

The `linger-s3-workflows` Worker is also required for normal diary writes. Set its
`AUTH_DB` database and `SESSIONS` namespace in `workers/s3-workflows/wrangler.jsonc` to the same resources
as Pages, and configure the same three secrets on that Worker. Keep the
`S3_WORKFLOW_SERVICE` service binding in `wrangler.toml` even if you do not use
S3 backup. GitHub Actions deploys this Worker, including its Durable Objects,
before deploying Pages.

### 4. Configure GitHub Actions

Add these repository secrets (Settings → Secrets and variables → Actions):
- `CLOUDFLARE_API_TOKEN` — Cloudflare API token with Pages edit, Workers Scripts edit, and D1 edit permissions (CI also deploys the `s3-workflows` Worker via `wrangler deploy`)
- `CLOUDFLARE_ACCOUNT_ID` — your Cloudflare account ID

Push to `main` and the app will be deployed automatically.

### Local development

For UI development without authentication:
```bash
npm install
npm run dev       # Vite dev server with HMR at http://localhost:5173
```

For the full stack (auth + Drive proxy) locally:
```bash
# Configure wrangler.toml (set D1/KV IDs, apply local auth migrations, add secrets)
npm run dev &             # Start Vite in the background
npm run workers:dev       # Wrangler Pages dev server at http://localhost:8788
```

#### Running the S3 Workflows Worker locally

S3 backfills run in a separate Worker (`workers/s3-workflows/`), reached from Pages
Functions via the `S3_WORKFLOW_SERVICE` service binding in `wrangler.toml`. That
binding only resolves if the Workflows Worker also has a `wrangler dev` session
running locally. This Worker also coordinates diary writes, including for users
who have never enabled S3 backup. If it is unavailable, diary mutations return
503 and retain unsynced edits as drafts; they never fall back to uncoordinated
writes. Run it in a second terminal alongside
`workers:dev`:

```bash
npx wrangler dev --config workers/s3-workflows/wrangler.jsonc --persist-to .wrangler/local-state
```

Wrangler auto-connects same-named local dev sessions, so once both are running,
`workers:dev`'s binding table shows `env.S3_WORKFLOW_SERVICE ... local [connected]` —
start order doesn't matter, it reconnects automatically either way. This worker also
warns about missing `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`SESSION_DOMAIN`
secrets — harmless if the session's Google token is still fresh, but it needs the
same values as your root `.dev.vars` to refresh an expired one (which any real
backfill run will eventually hit): copy `.dev.vars` to `workers/s3-workflows/.dev.vars`.

The `--persist-to .wrangler/local-state` flag must match on both commands (run from
the repo root) — each `wrangler dev` process otherwise gets its own local D1/KV/DO
storage even though both declare the same database and namespace IDs, so a session
created by `workers:dev` won't be found by this worker and every backfill call fails
with `Unauthorized`.

Other commands:
```bash
npm run ci:local     # run the local merge-check suite (build + lint + unit + workers + e2e)
npm run build        # type-check + production build → dist/
npm run lint         # ESLint on src/ and tests/
npm run preview      # serve the production build with Wrangler locally
npm test             # run the Playwright e2e test suite
npm run test:unit    # run Vitest unit tests
npm run test:workers # run the S3 Workflows Worker's test suite (@cloudflare/vitest-plugin)
```

#### UI preview params

Some UI states are hard to trigger naturally during development. Append `?preview=<value>` to the dev server URL to force them:

| Param | Effect |
|---|---|
| `?preview=empty-state` | Forces the "No entries yet" hint in the sidebar |
| `?preview-auth` | Skips the `/auth/session` check and mounts the app as signed in — useful for iterating on editor UI without a backend running |

> Note: Google OAuth requires the redirect URI to be registered. For local dev, add
> `http://localhost:8788/auth/callback` to your OAuth client's Authorized redirect URIs.

## Tech stack

- React 19 + TypeScript
- Vite 8 (with build-time prerendering of the signed-out landing page and CSP inline-hash injection)
- Cloudflare Pages + Pages Functions (auth + Drive API proxy + S3 proxy)
- Cloudflare D1 (authentication), KV (holiday cache and migration compatibility)
- Cloudflare Workers + Workflows + Durable Objects (`workers/s3-workflows/`, S3 mirror/backfill)
- Google Drive API v3 (plain `fetch`, server-side via Cloudflare Functions)
- Google OAuth 2.0 Authorization Code Flow with PKCE (server-side token refresh, `drive.file` scope)
- AWS STS `AssumeRoleWithWebIdentity` (short-lived S3 credentials from the Google id_token)
- `motion` for animations, `jszip` for ZIP export/import, `@github/relative-time-element`, `lucide-react` for icons, `unicode-emoji-json` for the emoji picker
- PWA via a service worker (`public/sw.js`) + Web App Manifest
- Playwright for e2e tests, Vitest for unit + Workers tests (`@cloudflare/vitest-plugin`)
- GitHub Actions + Cloudflare Pages (deployment), Terraform for Cloudflare (`infra/`) and the self-hosted S3 setup (`self-hosted/aws-s3/`)
