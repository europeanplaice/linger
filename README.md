# Linger — Google Drive Diary

A minimalist personal diary app. Entries are stored as Markdown files in your own Google Drive.

**[-> Open the app](https://linger.europeanplaice.com/)**

## Features

- Write daily diary entries, with manual save via button or Ctrl/Cmd+S
- Optional Drive auto-save after a few seconds of editing
- Calendar view to navigate by date, with dots marking days that have entries
- Previous/next day controls, plus Alt+Left / Alt+Right and Alt+Up for today
- Full-text search via Drive API, with on-demand snippet extraction from matched entries
- Delete entries with an explicit confirmation step
- Detect cross-device edit conflicts and choose whether to load latest, keep local edits, or overwrite
- View and restore past revisions of an entry
- Export all entries as a ZIP of Markdown files
- Settings modal for theme (light / dark / system), font, and language (English / Japanese)
- Data stays in your Google Drive (`linger_diary/` folder), one Markdown file per day
- Warns before reload or date changes when there are unsaved edits
- Works on mobile with a drawer sidebar, Android back-button support, and keyboard-aware layout
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

Scope: `drive.file` — non-sensitive, only accesses files this app created.

### Drive storage
All Drive API v3 calls are made server-side by Cloudflare Pages Functions at `/api/drive/…`.
The browser never holds an OAuth token. Diary entries are stored as individual plain-text files (MIME `text/plain`):

```
/linger_diary/
  diary-YYYY-MM-DD.txt   ← YAML frontmatter (date) + plain-text body
```

New entries are written as `.txt`. Legacy `.md` files remain readable and are renamed to `.txt` by a one-time migration on first sign-in.

Each file looks like:

```markdown
---
date: YYYY-MM-DD
updated_at: <ISO 8601 timestamp>
---

Entry content here…
```

Folder ID is cached in the Cloudflare KV session record after first lookup.
File upload uses multipart/related to set both metadata and content in one request.
Drive 429/5xx responses are retried with exponential backoff.

### State
- `useAuth` (`src/hooks/useAuth.ts`) — calls `/auth/session` on load to check sign-in state;
  exposes `{ status, tokenExpired, hadSession, email, signIn, signOut, handleExpired, retryAfterExpired }`
- `useDiary` (`src/hooks/useDiary.ts`) — on sign-in, calls `listEntries` via the `/api/drive/…`
  proxy; lazily fetches content per entry into a `Map<date, EntryCache>`;
  exposes `{ loading, error, dates, getContent, save, remove, search, refreshEntries, retryPendingSave, exportAll }`

### Local storage
The browser stores only non-sensitive preferences in `localStorage`:
- `linger_autosave` — whether auto-save is enabled
- `linger_theme` — `light` / `dark` / `system`
- `linger_font` — font preference
- `linger_fontsize` — font size (`sm` / `md` / `lg` / `xl`)
- `linger_language` — `en` / `ja`
- `linger_had_session` — `true`/`false` flag indicating whether the user was previously signed in (used to show the "continue with your previous session" prompt on the login screen)

No tokens or diary content are ever written to `localStorage`.

### Components
- `LoginScreen` — shown when not signed in
- `App` — sidebar + main panel layout
- `CalendarView` — monthly grid built with native `Date` arithmetic; dots on dates with entries
- `EntryEditor` — `<textarea>`, save/delete; Ctrl+S triggers save; handles conflict resolution
- `SearchBar` — full-text search via Drive API; fetches and caches entry content for snippet extraction
- `SettingsModal` — theme, font, language, auto-save, export, keyboard shortcuts
- `SessionExpiredModal` — prompts re-auth when the session expires and retries the pending save
- `HistoryModal` — view and restore past Drive revisions of an entry
- `ExportButton` — triggers ZIP export of all entries
- `ErrorBoundary` — catches render errors and displays a fallback UI

### Deployment
The app is deployed to **Cloudflare Pages** via GitHub Actions (see `.github/workflows/deploy.yml`).
The workflow runs lint, unit tests, and Playwright e2e tests, then deploys with `wrangler pages deploy`.

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
npm run build     # type-check + production build → dist/
npm run preview   # serve the production build with Wrangler locally
npm test          # run the Playwright e2e test suite
npm run test:unit # run Vitest unit tests
```

#### UI preview params

Some UI states are hard to trigger naturally during development. Append `?preview=<value>` to the dev server URL to force them:

| Param | Effect |
|---|---|
| `?preview=update-banner` | Forces the SW update banner visible at the top of the app |
| `?preview=empty-state` | Forces the "No entries yet" hint in the sidebar |

Params can be combined: `?preview=update-banner&preview=empty-state`

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
