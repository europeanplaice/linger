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

## How it works

### Auth flow
Uses **OAuth 2.0 Authorization Code Flow with PKCE** via Cloudflare Pages Functions:

1. Clicking "Sign in with Google" redirects to `/auth/login`, which generates a PKCE code verifier,
   stores it in Cloudflare KV (5-minute TTL), and redirects to Google's OAuth consent screen.
2. Google redirects back to `/auth/callback` with an authorization code.
3. The callback handler exchanges the code for access + refresh tokens (server-side, never exposed
   to the browser), stores the session in Cloudflare KV (30-day TTL), and sets an `HttpOnly`
   `Secure` `SameSite=Strict` session cookie (`linger_session`).
4. Subsequent requests include the session cookie; the Cloudflare middleware resolves the session,
   refreshes the access token if needed, and proxies the Drive API call.

Drive scope: `drive.file` — non-sensitive, only accesses files this app created.
The login flow also requests `openid email` so the app can identify the signed-in account and clear local cache on account switches.

`/auth/risc` receives Google [RISC](https://developers.google.com/identity/protocols/risc) Security Event Tokens (session/token revocation, account disabled, credential change) and revokes all Cloudflare KV sessions for the affected email server-side.

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

Folder ID is cached in the Cloudflare KV session record after first lookup.
File upload uses multipart/related to set both metadata and content in one request.
Drive 429/5xx responses are retried with exponential backoff.

### State
- `useAuth` (`src/hooks/useAuth.ts`) — calls `/auth/session` on load to check sign-in state;
  exposes `{ status, tokenExpired, hadSession, email, signIn, signOut, handleExpired, retryAfterExpired }`
- `useDiary` (`src/hooks/useDiary.ts`) — on sign-in, calls `listEntries` via the `/api/drive/…`
  proxy; lazily fetches content per entry into a `Map<date, EntryCache>`;
  hydrates recent entry metadata/content from IndexedDB, syncs Drive changes incrementally, prefetches likely next entries,
  and exposes `{ loading, freshListLoaded, error, dates, hasLegacyMdFiles, getContent, save, remove, search, refreshEntries, prefetch, retryPendingSave, exportAll }`

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
The workflow runs lint, unit tests, Playwright e2e tests, and `npm audit`, then deploys with `wrangler pages deploy`.

Pushes to `main` deploy to the production Pages project (`linger`); pushes to `staging` deploy to a separate `linger-staging` Pages project on `staging.linger.europeanplaice.com`, used to rehearse OAuth branding/consent-screen changes without risking the production app's verified status. Both environments' Cloudflare resources (KV namespaces, Pages projects, DNS) are managed via Terraform in `infra/`.

`vite.config.ts` uses `base: '/'` (correct for a custom domain).

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
2. Create a **KV namespace** for sessions:
   ```
   wrangler kv namespace create SESSIONS
   wrangler kv namespace create SESSIONS --preview
   ```
3. Copy `wrangler.toml.example` to `wrangler.toml` and fill in the KV namespace IDs
4. Add the following secrets via the Cloudflare dashboard or `wrangler pages secret put`:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `SESSION_DOMAIN` (e.g. `https://your-domain.com`)

### 4. Configure GitHub Actions

Add these repository secrets (Settings → Secrets and variables → Actions):
- `CLOUDFLARE_API_TOKEN` — Cloudflare API token with Pages edit permissions
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
# Copy and configure wrangler.toml (set KV IDs, add secrets via wrangler)
npm run dev &             # Start Vite in the background
npm run workers:dev       # Wrangler Pages dev server at http://localhost:8788
```

Other commands:
```bash
npm run ci:local     # run the local merge-check suite (build + lint + unit + e2e)
npm run build        # type-check + production build → dist/
npm run lint         # ESLint on src/ and tests/
npm run preview      # serve the production build with Wrangler locally
npm test             # run the Playwright e2e test suite
npm run test:unit    # run Vitest unit tests
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
- Vite 8
- Cloudflare Pages + Pages Functions (auth + Drive API proxy)
- Cloudflare KV (session storage)
- Google Drive API v3 (plain `fetch`, server-side via Cloudflare Functions)
- Google OAuth 2.0 Authorization Code Flow with PKCE
- Playwright for e2e tests, Vitest for unit tests
- GitHub Actions + Cloudflare Pages (deployment)
