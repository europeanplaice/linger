import type { S3WorkflowService } from './s3Workflow'
import { createD1Session, isD1SessionRevoked, legacyAuthEnabled, readD1Session, revokeD1Account, revokeD1Session, saveD1Session, sanitizeSession } from './authStore'

export const SESSION_TTL = 60 * 60 * 24 * 30 // 30 days

const COOKIE_NAME = 'linger_session'
const OAUTH_STATE_COOKIE_NAME = 'linger_oauth_state'
export const OAUTH_STATE_TTL = 300

export interface Env {
  SESSIONS: KVNamespace
  AUTH_DB?: D1Database
  AUTH_KV_FALLBACK_UNTIL?: string
  AUTH_KV_REVOCATION_CHECK_UNTIL?: string
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  SESSION_DOMAIN: string
  CF_PAGES_COMMIT_SHA?: string
  S3_WORKFLOW_SERVICE?: S3WorkflowService
  // Present inside the Workflow Worker. Pages uses S3_WORKFLOW_SERVICE instead;
  // both bindings route folder discovery to the same account-scoped object.
  DIARY_WRITER?: {
    getByName(name: string): {
      ensureFolder(input: { sessionId: string; accountKey: string; accessToken: string; expiresAt: number; idToken?: string }): Promise<string>
    }
  }
}

export interface SessionData {
  access_token?: string
  expires_at?: number // ms since epoch; only in the current request
  folder_id?: string
  renewed_at?: number // ms since epoch — throttles sliding session renewal
  email?: string
  changes_start_page_token?: string // Drive Changes API page token for incremental sync
  client_id?: string // OAuth client ID associated with the verified account session
  id_token?: string // Google-signed JWT (openid scope) — handed to AWS STS AssumeRoleWithWebIdentity for self-hosted S3
  id_token_verified?: boolean // true only after local Google signature/claims validation
  google_sub?: string // stable per-user Google account ID, decoded once from id_token; not re-derived on refresh since it never changes
  s3_settings_negative_cache_at?: number // ms since epoch — last time a save/delete confirmed no s3_settings.json exists, so Drive-only users don't pay a files.list lookup on every save
  s3_settings_file_id?: string // Drive fileId of s3_settings.json, cached like folder_id so every mirror/poll doesn't pay a files.list lookup just to find the settings file — never the settings *content* itself (see s3Settings.ts's loadS3SettingsRecord), since a stale bucket/roleArn/enabled value could mirror content to a bucket the user just disabled or changed
  s3_status_file_id?: string // Drive fileId of s3_sync_status.json (see s3Settings.ts) — split out of s3_settings.json so background sync-status writes never share a file (and thus a last-write-wins overwrite) with the user's own config saves. Cached the same way and for the same reason as s3_settings_file_id
  s3_status_negative_cache_at?: number // ms since epoch — mirrors s3_settings_negative_cache_at, but for "no s3_sync_status.json exists yet". Without this, every mirror on an account that syncs cleanly (recordMirrorSuccess is a no-op when there's no error to clear, so the status file may never even get created) would pay a files.list lookup on every single save, forever
}

// These Drive file ids and negative lookups are scoped to folder_id. Clear them
// whenever account-level folder reconciliation moves a session to another folder.
export function invalidateFolderScopedS3Cache(session: SessionData): void {
  session.s3_settings_file_id = undefined
  session.s3_status_file_id = undefined
  session.s3_settings_negative_cache_at = undefined
  session.s3_status_negative_cache_at = undefined
}

export interface Data extends Record<string, unknown> {
  sessionId: string
  accessToken: string
  idToken?: string
  session: SessionData
}

export function validateRequestAccount(request: Request, session: SessionData): Response | null {
  const expected = session.google_sub ? `sub:${session.google_sub}`
    : session.email ? `email:${encodeURIComponent(session.email.trim().toLowerCase())}` : null
  if (expected && request.headers.get('X-Linger-Account') === expected) return null
  // Do not clear the cookie: it may belong to the new account in another tab.
  return jsonResponse({ error: 'Account changed', code: 'account_changed' }, 401, { 'X-Linger-Account-Changed': '1' })
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
  if (env.AUTH_DB) return readD1Session(sessionId, { ...env, AUTH_DB: env.AUTH_DB })
  const raw = await env.SESSIONS.get(`session:${sessionId}`)
  if (!raw) return null
  if (await isSessionRevoked(sessionId, env)) return null
  try {
    return sanitizeSession(JSON.parse(raw) as SessionData)
  } catch {
    return null
  }
}

export async function saveSession(sessionId: string, session: SessionData, env: Env): Promise<void> {
  if (env.AUTH_DB) return saveD1Session(sessionId, session, { ...env, AUTH_DB: env.AUTH_DB })
  if (await isSessionRevoked(sessionId, env)) throw new SessionRevokedError('Session revoked')
  await env.SESSIONS.put(`session:${sessionId}`, JSON.stringify(sanitizeSession(session)), { expirationTtl: SESSION_TTL })
  // Revocation can finish while put() is in flight. Its separate marker remains
  // authoritative even if another location still reads this late session write.
  if (await isSessionRevoked(sessionId, env)) {
    await env.SESSIONS.delete(`session:${sessionId}`)
    throw new SessionRevokedError('Session revoked')
  }
}

export async function createSession(sessionId: string, session: SessionData, env: Env): Promise<void> {
  if (env.AUTH_DB) {
    session.renewed_at = Date.now()
    return createD1Session(sessionId, sanitizeSession(session), { ...env, AUTH_DB: env.AUTH_DB })
  }
  return saveSession(sessionId, sanitizeSession(session), env)
}

export async function isSessionRevoked(sessionId: string, env: Env): Promise<boolean> {
  if (env.AUTH_DB) return isD1SessionRevoked(sessionId, { ...env, AUTH_DB: env.AUTH_DB })
  return await env.SESSIONS.get(`revoked-session:${sessionId}`) === '1'
}

export class RefreshTokenInvalidError extends Error {}
export class SessionRevokedError extends RefreshTokenInvalidError {}

export async function getValidSession(_sessionId: string, session: SessionData, _env: Env, opts: { forceRefresh?: boolean } = {}): Promise<SessionData> {
  if (!opts.forceRefresh && session.access_token && session.expires_at && session.expires_at > Date.now() + 60_000) return session
  throw new Error("Google credentials are request-scoped; sign in again")
}

export async function getValidAccessToken(sessionId: string, session: SessionData, env: Env): Promise<string> {
  const validSession = await getValidSession(sessionId, session, env)
  if (!validSession.access_token) throw new Error("Google access token is not available in this request")
  return validSession.access_token
}

export async function getValidIdToken(sessionId: string, session: SessionData, env: Env): Promise<string | null> {
  const validSession = await getValidSession(sessionId, session, env)
  return validSession.id_token_verified && validSession.id_token ? validSession.id_token : null
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
  if (env.AUTH_DB) return // D1 maintains the indexed identity columns atomically.
  await env.SESSIONS.put(emailSessionIndexKey(email, sessionId), '', { expirationTtl: SESSION_TTL })
}

export async function removeEmailSessionIndex(email: string, sessionId: string, env: Env): Promise<void> {
  if (env.AUTH_DB && !legacyAuthEnabled(env)) return
  await env.SESSIONS.delete(emailSessionIndexKey(email, sessionId))
}

export async function addSubSessionIndex(sub: string, sessionId: string, env: Env): Promise<void> {
  if (env.AUTH_DB) return
  await env.SESSIONS.put(subSessionIndexKey(sub, sessionId), '', { expirationTtl: SESSION_TTL })
}

export async function removeSubSessionIndex(sub: string, sessionId: string, env: Env): Promise<void> {
  if (env.AUTH_DB && !legacyAuthEnabled(env)) return
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

// Write revocation separately before deleting tokens or indexes. An in-flight
// refresh/renewal must never restore authorization by recreating session:{id}.
// IDs are never reused; the marker contains no credentials and has no TTL because
// a late writer can extend the session record beyond its original expiration.
// KV propagation is still eventually consistent, just as for session deletion.
export async function invalidateSession(sessionId: string, email: string | undefined, env: Env, googleSub?: string): Promise<void> {
  if (env.AUTH_DB) {
    await revokeD1Session(sessionId, { ...env, AUTH_DB: env.AUTH_DB })
    if (!legacyAuthEnabled(env)) return
  }
  await env.SESSIONS.put(`revoked-session:${sessionId}`, '1')
  await env.SESSIONS.delete(`session:${sessionId}`)
  if (email) {
    await removeEmailSessionIndex(email, sessionId, env)
  }
  if (googleSub) {
    await removeSubSessionIndex(googleSub, sessionId, env)
  }
}

// Attempt every session, but report partial failure so the security event can be
// retried. Delete a record before its index: a failed record deletion must leave
// the live session discoverable on the next attempt.
async function revokeSessions(operations: Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(operations)
  if (results.some(result => result.status === 'rejected')) {
    throw new Error('Session revocation incomplete')
  }
}

export async function deleteAllSessionsForEmail(email: string, env: Env): Promise<void> {
  if (env.AUTH_DB) {
    await revokeD1Account('email', email, { ...env, AUTH_DB: env.AUTH_DB })
    if (!legacyAuthEnabled(env)) return
  }
  const ids = await listSessionIdsForEmail(email, env)
  await revokeSessions(ids.map(id => invalidateSession(id, email, env)))
}

export async function deleteAllSessionsForSub(sub: string, env: Env): Promise<void> {
  if (env.AUTH_DB) {
    await revokeD1Account('google_sub', sub, { ...env, AUTH_DB: env.AUTH_DB })
    if (!legacyAuthEnabled(env)) return
  }
  const ids = await listSessionIdsForPrefix(subSessionIndexPrefix(sub), env)
  await revokeSessions(ids.map(async id => {
    const session = await getSession(id, env)
    await invalidateSession(id, session?.email, env, sub)
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
