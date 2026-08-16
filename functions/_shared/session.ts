import type { S3WorkflowService } from './s3Workflow'
import { verifyGoogleIdToken } from './google'

export const SESSION_TTL = 60 * 60 * 24 * 30 // 30 days

const COOKIE_NAME = 'linger_session'
const OAUTH_STATE_COOKIE_NAME = 'linger_oauth_state'
export const OAUTH_STATE_TTL = 300

export interface Env {
  SESSIONS: KVNamespace
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  SESSION_DOMAIN: string
  CF_PAGES_COMMIT_SHA?: string
  S3_WORKFLOW_SERVICE?: S3WorkflowService
}

export interface SessionData {
  refresh_token: string
  access_token: string
  expires_at: number // ms since epoch
  folder_id?: string
  renewed_at?: number // ms since epoch — tracks last KV write to throttle sliding TTL renewal
  email?: string
  changes_start_page_token?: string // Drive Changes API page token for incremental sync
  client_id?: string // GOOGLE_CLIENT_ID that minted refresh_token — lets a Blue/Green OAuth swap tell stale tokens apart
  id_token?: string // Google-signed JWT (openid scope) — handed to AWS STS AssumeRoleWithWebIdentity for self-hosted S3
  id_token_verified?: boolean // true only after local Google signature/claims validation
  google_sub?: string // stable per-user Google account ID, decoded once from id_token; not re-derived on refresh since it never changes
  s3_settings_negative_cache_at?: number // ms since epoch — last time a save/delete confirmed no s3_settings.json exists, so Drive-only users don't pay a files.list lookup on every save
  s3_settings_file_id?: string // Drive fileId of s3_settings.json, cached like folder_id so every mirror/poll doesn't pay a files.list lookup just to find the settings file — never the settings *content* itself (see s3Settings.ts's loadS3SettingsRecord), since a stale bucket/roleArn/enabled value could mirror content to a bucket the user just disabled or changed
  s3_status_file_id?: string // Drive fileId of s3_sync_status.json (see s3Settings.ts) — split out of s3_settings.json so background sync-status writes never share a file (and thus a last-write-wins overwrite) with the user's own config saves. Cached the same way and for the same reason as s3_settings_file_id
  s3_status_negative_cache_at?: number // ms since epoch — mirrors s3_settings_negative_cache_at, but for "no s3_sync_status.json exists yet". Without this, every mirror on an account that syncs cleanly (recordMirrorSuccess is a no-op when there's no error to clear, so the status file may never even get created) would pay a files.list lookup on every single save, forever
  // Assumed AWS credentials for self-hosted S3 mirroring, persisted here (see
  // s3Settings.ts's getAssumedCredentials) so they survive across requests — the
  // in-isolate Map cache in s3.ts rarely helps a low-traffic personal account, since
  // Workers isolates go cold between sparse requests far more often than that cache
  // gets reused. `cacheKey` matches credentialsCacheKey(session, config) — a
  // roleArn/region change invalidates the cache by no longer matching it. Same
  // security posture as id_token/refresh_token already stored in this same record:
  // scoped to the user's own bucket via their own IAM role, and short-lived (1hr).
  s3_assumed_credentials?: {
    accessKeyId: string
    secretAccessKey: string
    sessionToken: string
    expiresAt: number // ms since epoch
    cacheKey: string
  }
}

export interface Data extends Record<string, unknown> {
  sessionId: string
  accessToken: string
  session: SessionData
}

export function parseSessionId(request: Request): string | null {
  const header = request.headers.get('Cookie') ?? ''
  for (const part of header.split(';')) {
    const trimmed = part.trim()
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const name = trimmed.slice(0, eq)
    const value = trimmed.slice(eq + 1)
    if (name === COOKIE_NAME && value) {
      try { return decodeURIComponent(value) } catch { return null }
    }
  }
  return null
}

export async function getSession(sessionId: string, env: Env): Promise<SessionData | null> {
  const raw = await env.SESSIONS.get(`session:${sessionId}`)
  if (!raw) return null
  try {
    return JSON.parse(raw) as SessionData
  } catch {
    return null
  }
}

export async function saveSession(sessionId: string, session: SessionData, env: Env): Promise<void> {
  await env.SESSIONS.put(`session:${sessionId}`, JSON.stringify(session), { expirationTtl: SESSION_TTL })
}

// Thrown only when Google says the refresh_token itself is dead (400 invalid_grant —
// e.g. revoked, or minted by a since-retired Blue/Green OAuth client). Distinct from
// transient failures (429/5xx) so callers only tear down the session in this case.
export class RefreshTokenInvalidError extends Error {}

// Retry delays for transient refresh failures (network error, 429, 5xx) — mirrors
// driveWithRetry's backoff (functions/_shared/drive.ts). Without this, a single Google
// blip during an access-token refresh (which happens on the order of hourly for an
// active user) surfaced as a full "session expired, please log in again" instead of
// self-healing, since callers of getValidSession treat any thrown error alike.
const REFRESH_RETRY_DELAYS_MS = [250, 500, 1000]

// Dedupes concurrent refreshes for the same session within one isolate: on app load
// or tab wake-up, several API requests fire in parallel, and if the access token has
// just expired they'd all independently hit Google's token endpoint with the same
// refresh_token — stampeding it, inflating the odds of a 429 (or of *some* request
// hitting a transient blip and surfacing a spurious failure), and multiplying KV
// writes. The first request to need a refresh performs it and persists the result;
// the rest wait for it and then adopt the tokens it left in KV. Scoped to the
// isolate — a cold-start isolate can't join another isolate's in-flight refresh, but
// then each isolate only ever does its own one refresh per expiry window anyway.
const inFlightRefreshes = new Map<string, Promise<SessionData>>()

// Mutates `session` in place (rather than returning a disconnected copy) and persists
// it to KV itself whenever it refreshes, so every caller holding this same object
// reference — including ones further down the call stack that read it well after this
// call returns — sees the refreshed tokens immediately, and none of them can undo the
// refresh by later saving their own stale snapshot over it. Previously returned a new
// object on refresh; a caller (or anything called after it, e.g. a mirror's own
// saveSession) that kept using its original `session` variable would silently save back
// the pre-refresh tokens, clobbering the fresh ones this function had just persisted.
export async function getValidSession(sessionId: string, session: SessionData, env: Env, opts: { forceRefresh?: boolean } = {}): Promise<SessionData> {
  if (!opts.forceRefresh && session.expires_at > Date.now() + 60_000) {
    return session
  }

  const inFlight = inFlightRefreshes.get(sessionId)
  if (inFlight) {
    // Another request in this isolate is refreshing this same session right now —
    // wait for it, then adopt whatever tokens it persisted. If the shared refresh
    // failed (transient blip), rethrow its error rather than handing back an expired
    // token: a caller proceeding on that would 401 against Drive and re-trigger the
    // session-expired flow for a session that's perfectly alive, and the error type
    // matters (RefreshTokenInvalidError must still tear the session down).
    let sharedError: unknown
    try {
      await inFlight
    } catch (err) {
      sharedError = err
    }
    const fresh = await getSession(sessionId, env)
    if (fresh?.access_token && fresh.expires_at > Date.now() + 60_000) {
      Object.assign(session, fresh)
      return session
    }
    if (sharedError) throw sharedError
    throw new Error('Token refresh failed')
  }

  const refresh = refreshAccessToken(sessionId, session, env)
  inFlightRefreshes.set(sessionId, refresh)
  try {
    return await refresh
  } finally {
    if (inFlightRefreshes.get(sessionId) === refresh) inFlightRefreshes.delete(sessionId)
  }
}

// The actual refresh-and-persist loop, extracted from getValidSession so concurrent
// callers can share a single in-flight attempt (see inFlightRefreshes above). Mutates
// `session` in place and persists the fresh tokens to KV itself.
async function refreshAccessToken(sessionId: string, session: SessionData, env: Env): Promise<SessionData> {
  let resp: Response
  for (let attempt = 0; ; attempt++) {
    try {
      resp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          refresh_token: session.refresh_token,
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          grant_type: 'refresh_token',
        }).toString(),
      })
    } catch (err) {
      if (attempt < REFRESH_RETRY_DELAYS_MS.length) {
        await new Promise(r => setTimeout(r, REFRESH_RETRY_DELAYS_MS[attempt] * (1 + 0.2 * (Math.random() * 2 - 1))))
        continue
      }
      throw err
    }
    // Google returns 400 invalid_grant for a dead/revoked/wrong-client refresh_token —
    // fails immediately, retrying won't help. Anything else (429, 5xx) is transient —
    // don't destroy an otherwise-valid session over it, retry a few times first.
    if (!resp.ok && resp.status !== 400 && attempt < REFRESH_RETRY_DELAYS_MS.length) {
      let delay = REFRESH_RETRY_DELAYS_MS[attempt]
      const ra = resp.headers.get('Retry-After')
      if (ra) { const s = parseFloat(ra); if (!isNaN(s)) delay = s * 1000 }
      await new Promise(r => setTimeout(r, delay * (1 + 0.2 * (Math.random() * 2 - 1))))
      continue
    }
    break
  }
  if (!resp.ok) {
    if (resp.status === 400) {
      // Any 400 from the token endpoint is a request/grant/client problem, not a
      // transient one — retrying gets the same 400 again. invalid_grant (dead/revoked/
      // wrong-client refresh_token) is the expected, routine case. Anything else
      // (e.g. invalid_client from a client_id/secret mismatch after an OAuth
      // blue/green swap) is unexpected and env-wide — log it so it doesn't fail
      // silently, since it'll otherwise look identical to a normal expired session.
      let errorCode = 'unknown'
      try {
        const errJson = await resp.json() as { error?: string }
        if (errJson.error) errorCode = errJson.error
      } catch {
        // non-JSON body, leave errorCode as 'unknown'
      }
      if (errorCode !== 'invalid_grant') {
        console.error(`Token refresh got 400 with unexpected error code: ${errorCode}`)
      }
      throw new RefreshTokenInvalidError(`Token refresh failed: ${resp.status} (${errorCode})`)
    }
    throw new Error(`Token refresh failed: ${resp.status}`)
  }
  const tokens = await resp.json() as { access_token: string; expires_in: number; id_token?: string }
  let idToken: string | undefined
  if (tokens.id_token) {
    try {
      const claims = await verifyGoogleIdToken(tokens.id_token, env.GOOGLE_CLIENT_ID)
      if (!session.google_sub || claims.sub === session.google_sub) idToken = tokens.id_token
    } catch {
      // Never persist an unverified ID token. Access-token use can continue,
      // while callers that require an ID token will request a later refresh.
    }
  }
  Object.assign(session, {
    access_token: tokens.access_token,
    expires_at: Date.now() + tokens.expires_in * 1000,
    // A successful refresh proves refresh_token is valid for the current client —
    // stamp it so legacy sessions (created before client_id was tracked) self-heal.
    client_id: env.GOOGLE_CLIENT_ID,
    // id_token shares this same refresh response's expires_in, so a previous id_token
    // is expired by definition whenever this branch runs. Carry forward only a freshly
    // issued one; otherwise drop it rather than handing callers a dead token that would
    // make every subsequent STS AssumeRoleWithWebIdentity call fail silently.
    id_token: idToken,
    id_token_verified: idToken ? true : undefined,
  })
  await saveSession(sessionId, session, env)
  return session
}

export async function getValidAccessToken(sessionId: string, session: SessionData, env: Env): Promise<string> {
  const validSession = await getValidSession(sessionId, session, env)
  return validSession.access_token
}

// id_token shares the same expiry as access_token (both minted in the same token
// response), so freshness normally reuses getValidSession's expires_at check rather
// than tracking a second timestamp. But Google's refresh-token grant doesn't always
// re-include id_token (see the comment above on dropping a stale one) — when that
// happens, id_token stays missing until access_token itself next expires, up to ~1hr
// later, silently breaking every S3 mirror attempt in the meantime with no way to
// self-heal sooner. Force a refresh here whenever id_token is missing, since only
// getValidIdToken callers actually need it — a plain getValidAccessToken caller has no
// reason to pay for an early refresh just because id_token happens to be absent.
export async function getValidIdToken(sessionId: string, session: SessionData, env: Env): Promise<string | null> {
  const validSession = await getValidSession(sessionId, session, env, { forceRefresh: !session.id_token || session.id_token_verified !== true })
  return validSession.id_token ?? null
}

export function makeSessionCookie(sessionId: string, maxAge: number, secure = true): string {
  const secureFlag = secure ? '; Secure' : ''
  return `${COOKIE_NAME}=${encodeURIComponent(sessionId)}; HttpOnly${secureFlag}; SameSite=Strict; Path=/; Max-Age=${maxAge}`
}

export function clearSessionCookie(secure = true): string {
  const secureFlag = secure ? '; Secure' : ''
  return `${COOKIE_NAME}=; HttpOnly${secureFlag}; SameSite=Strict; Path=/; Max-Age=0`
}

export function makeOAuthStateCookie(state: string, secure = true): string {
  const secureFlag = secure ? '; Secure' : ''
  return `${OAUTH_STATE_COOKIE_NAME}=${encodeURIComponent(state)}; HttpOnly${secureFlag}; SameSite=Lax; Path=/; Max-Age=${OAUTH_STATE_TTL}`
}

export function clearOAuthStateCookie(secure = true): string {
  const secureFlag = secure ? '; Secure' : ''
  return `${OAUTH_STATE_COOKIE_NAME}=; HttpOnly${secureFlag}; SameSite=Lax; Path=/; Max-Age=0`
}

export function parseOAuthStateCookie(request: Request): string | null {
  const header = request.headers.get('Cookie') ?? ''
  for (const part of header.split(';')) {
    const trimmed = part.trim()
    const eq = trimmed.indexOf('=')
    if (eq === -1 || trimmed.slice(0, eq) !== OAUTH_STATE_COOKIE_NAME) continue
    try { return decodeURIComponent(trimmed.slice(eq + 1)) || null } catch { return null }
  }
  return null
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

// Each session gets its own KV key under an email-prefixed namespace, rather than
// one aggregate key holding a JSON array of session IDs. That aggregate design
// required a read-modify-write on every add/remove with no locking — two devices
// signing in for the same email at close to the same time (or even ~60s apart,
// given KV's edge-cache/propagation delay) could both read the same stale array
// and each append their own session ID, silently dropping the other's from the
// index on whichever `put` landed last. The dropped session's own `session:{id}`
// record stayed valid — it just became unreachable via the index, so it survived
// deleteAllSessionsForEmail (used by /auth/risc's revocation) and was invisible to
// getRefreshTokenForEmail. Keying by session ID makes every add/remove a single
// put/delete with nothing to read first, so this class of lost update can't happen.
function emailSessionIndexPrefix(email: string): string {
  return `esidx:${normalizeEmail(email)}:`
}

function emailSessionIndexKey(email: string, sessionId: string): string {
  return `${emailSessionIndexPrefix(email)}${sessionId}`
}

function subSessionIndexPrefix(sub: string): string {
  return `ssidx:${sub}:`
}

function subSessionIndexKey(sub: string, sessionId: string): string {
  return `${subSessionIndexPrefix(sub)}${sessionId}`
}

// Also called on every sliding TTL renewal (see _middleware.ts) to re-stamp this
// key's own TTL in step with the session record's — otherwise an actively-used,
// renewed session would still fall out of the index (and out of RISC's reach)
// after the *original* login's TTL, even though the session itself lives on.
export async function addEmailSessionIndex(email: string, sessionId: string, env: Env): Promise<void> {
  await env.SESSIONS.put(emailSessionIndexKey(email, sessionId), '', { expirationTtl: SESSION_TTL })
}

export async function removeEmailSessionIndex(email: string, sessionId: string, env: Env): Promise<void> {
  await env.SESSIONS.delete(emailSessionIndexKey(email, sessionId))
}

export async function addSubSessionIndex(sub: string, sessionId: string, env: Env): Promise<void> {
  await env.SESSIONS.put(subSessionIndexKey(sub, sessionId), '', { expirationTtl: SESSION_TTL })
}

export async function removeSubSessionIndex(sub: string, sessionId: string, env: Env): Promise<void> {
  await env.SESSIONS.delete(subSessionIndexKey(sub, sessionId))
}

// Caps list() pagination — no real account will ever approach this many
// concurrent sessions; it only bounds worst-case latency against a very long-
// lived account's index.
const MAX_INDEX_LIST_PAGES = 10

async function listSessionIdsForEmail(email: string, env: Env): Promise<string[]> {
  const prefix = emailSessionIndexPrefix(email)
  const ids: string[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_INDEX_LIST_PAGES; page++) {
    const result = await env.SESSIONS.list({ prefix, cursor })
    ids.push(...result.keys.map(k => k.name.slice(prefix.length)))
    if (result.list_complete) break
    cursor = result.cursor
  }
  return ids
}

// Only reuses a refresh_token minted by the currently-live OAuth client — after a
// Blue/Green client swap, a token from the retired client is rejected by Google
// (invalid_grant) on every refresh, so blindly reusing the oldest surviving session
// forces the user into a repeated fail-then-relogin loop instead of a single relogin.
export async function getRefreshTokenForEmail(email: string, clientId: string, env: Env): Promise<string | null> {
  const ids = await listSessionIdsForEmail(email, env)
  for (const id of ids) {
    const session = await getSession(id, env)
    if (session?.refresh_token && session.client_id === clientId) return session.refresh_token
  }
  return null
}

export async function getRefreshTokenForSub(sub: string, clientId: string, env: Env): Promise<string | null> {
  const ids = await listSessionIdsForPrefix(subSessionIndexPrefix(sub), env)
  for (const id of ids) {
    const session = await getSession(id, env)
    if (session?.refresh_token && session.client_id === clientId) return session.refresh_token
  }
  return null
}

async function listSessionIdsForPrefix(prefix: string, env: Env): Promise<string[]> {
  const ids: string[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_INDEX_LIST_PAGES; page++) {
    const result = await env.SESSIONS.list({ prefix, cursor })
    ids.push(...result.keys.map(k => k.name.slice(prefix.length)))
    if (result.list_complete) break
    cursor = result.cursor
  }
  return ids
}

// Removes a single dead session (e.g. refresh failed) from both the session record
// and the email index, so it stops being offered as a reuse candidate by
// getRefreshTokenForEmail while it waits out its KV TTL. Deletes the session record
// first: if only one of the two deletes can land, a dangling index entry (harmless
// — getSession returns null for it and every caller already skips null sessions)
// is far preferable to a live session left silently unreachable via the index.
export async function invalidateSession(sessionId: string, email: string | undefined, env: Env, googleSub?: string): Promise<void> {
  await env.SESSIONS.delete(`session:${sessionId}`)
  if (email) {
    await removeEmailSessionIndex(email, sessionId, env)
  }
  if (googleSub) {
    await removeSubSessionIndex(googleSub, sessionId, env)
  }
}

// Each session's index entry is independent (see addEmailSessionIndex), so unlike
// the old shared-array design there's no combined state that a partial failure
// could corrupt — one session's delete failing can't affect another's. A session
// whose KV delete fails here simply lingers until its own pre-existing TTL, the
// same bounded residual risk this function already carried before this change.
export async function deleteAllSessionsForEmail(email: string, env: Env): Promise<void> {
  const ids = await listSessionIdsForEmail(email, env)
  await Promise.allSettled(ids.map(async id => {
    await Promise.allSettled([
      env.SESSIONS.delete(`session:${id}`),
      removeEmailSessionIndex(email, id, env),
    ])
  }))
}

export async function deleteAllSessionsForSub(sub: string, env: Env): Promise<void> {
  const ids = await listSessionIdsForPrefix(subSessionIndexPrefix(sub), env)
  await Promise.allSettled(ids.map(async id => {
    const session = await getSession(id, env)
    await Promise.allSettled([
      env.SESSIONS.delete(`session:${id}`),
      removeSubSessionIndex(sub, id, env),
      ...(session?.email ? [removeEmailSessionIndex(session.email, id, env)] : []),
    ])
  }))
}

export function jsonResponse(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  })
}

function originOf(value: string): string | null {
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

function allowedOrigins(request: Request, env: Env): Set<string> {
  const origins = new Set<string>()
  const sessionOrigin = originOf(env.SESSION_DOMAIN)
  const requestOrigin = originOf(request.url)
  if (sessionOrigin) origins.add(sessionOrigin)
  if (requestOrigin) origins.add(requestOrigin)

  // Local development commonly proxies Vite (5173) to Pages Functions (8788).
  if (sessionOrigin?.startsWith('http://localhost') || sessionOrigin?.startsWith('http://127.0.0.1')) {
    origins.add('http://localhost:5173')
    origins.add('http://127.0.0.1:5173')
  }

  return origins
}

export function validateMutationOrigin(request: Request, env: Env): Response | null {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method.toUpperCase())) return null

  const origin = request.headers.get('Origin')
  if (origin && !allowedOrigins(request, env).has(origin)) {
    return jsonResponse({ error: 'Forbidden' }, 403)
  }

  const fetchSite = request.headers.get('Sec-Fetch-Site')
  // 'none' means the request has no browsing context initiator (e.g. browser extension,
  // direct navigation) — not a cross-site page load, so it is safe to allow.
  if (fetchSite && !['same-origin', 'same-site', 'none'].includes(fetchSite)) {
    return jsonResponse({ error: 'Forbidden' }, 403)
  }

  return null
}
