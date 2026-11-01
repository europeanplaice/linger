import type { Env, SessionData } from './session'
import { OAUTH_STATE_TTL, SESSION_TTL, SessionRevokedError } from './session'

type AuthEnv = Env & { AUTH_DB: D1Database }
interface SessionRow { data: string | null; revoked: number; expires_at: number }

// No Sessions API/read replicas here: logout and RISC must see primary state.
export function legacyAuthEnabled(env: Env): boolean {
  // Credential-bearing KV sessions are no longer supported. Existing D1 sessions
  // are scrubbed by migration 0002; never import old KV values after that cutover.
  void env
  return false
}

async function revokedDuringCutover(id: string, env: AuthEnv): Promise<boolean> {
  const until = Date.parse(env.AUTH_KV_REVOCATION_CHECK_UNTIL ?? '')
  if (!legacyAuthEnabled(env) || !Number.isFinite(until) || Date.now() >= until) return false
  if (await env.SESSIONS.get(`revoked-session:${id}`) !== '1') return false
  await revokeD1Session(id, env)
  return true
}

function decode(row: SessionRow | null): SessionData | null {
  if (!row?.data || row.revoked || row.expires_at <= Date.now()) return null
  try { return sanitizeSession(JSON.parse(row.data) as SessionData) } catch { return null }
}

// Persist an explicit metadata-only projection. Credentials are request-scoped and
// must never be serialized to D1 or KV, even if a caller passes a whole SessionData.
export function sanitizeSession(session: SessionData): SessionData {
  return {
    ...(typeof session.folder_id === 'string' ? { folder_id: session.folder_id } : {}),
    ...(typeof session.renewed_at === 'number' && Number.isFinite(session.renewed_at) ? { renewed_at: session.renewed_at } : {}),
    ...(typeof session.changes_start_page_token === 'string' ? { changes_start_page_token: session.changes_start_page_token } : {}),
    ...(typeof session.client_id === 'string' ? { client_id: session.client_id } : {}),
    ...(typeof session.google_sub === 'string' ? { google_sub: session.google_sub } : {}),
    ...(typeof session.s3_settings_negative_cache_at === 'number' && Number.isFinite(session.s3_settings_negative_cache_at) ? { s3_settings_negative_cache_at: session.s3_settings_negative_cache_at } : {}),
    ...(typeof session.s3_settings_file_id === 'string' ? { s3_settings_file_id: session.s3_settings_file_id } : {}),
    ...(typeof session.s3_status_file_id === 'string' ? { s3_status_file_id: session.s3_status_file_id } : {}),
    ...(typeof session.s3_status_negative_cache_at === 'number' && Number.isFinite(session.s3_status_negative_cache_at) ? { s3_status_negative_cache_at: session.s3_status_negative_cache_at } : {}),
  }
}

function adopt(session: SessionData, fresh: SessionData): void {
  const ephemeral = {
    access_token: session.access_token,
    expires_at: session.expires_at,
    id_token: session.id_token,
    id_token_verified: session.id_token_verified,
  }
  for (const key of Object.keys(session)) Reflect.deleteProperty(session, key)
  Object.assign(session, fresh, ephemeral)
}

export async function readD1Session(id: string, env: AuthEnv): Promise<SessionData | null> {
  let row = await env.AUTH_DB.prepare('SELECT data, revoked, expires_at FROM auth_sessions WHERE id = ?').bind(id).first<SessionRow>()
  if (row) {
    const session = decode(row)
    return session && await revokedDuringCutover(id, env) ? null : session
  }
  if (!legacyAuthEnabled(env)) return null

  // Lazy, insert-only import. A concurrent logout leaves a tombstone which this
  // import cannot overwrite. Never fall back to KV when D1 itself is unavailable.
  const [raw, revoked, keys] = await Promise.all([
    env.SESSIONS.get(`session:${id}`),
    env.SESSIONS.get(`revoked-session:${id}`),
    env.SESSIONS.list({ prefix: `session:${id}`, limit: 1 }),
  ])
  if (revoked === '1') { await revokeD1Session(id, env); return null }
  if (!raw) return null
  const expiry = keys.keys.find(key => key.name === `session:${id}`)?.expiration
  // Real legacy sessions always have a KV TTL. Do not prolong it on import.
  if (!expiry || expiry * 1000 <= Date.now()) return null
  let session: SessionData
  try { session = JSON.parse(raw) as SessionData } catch { return null }
  await insertSession(id, session, expiry * 1000, env, true)
  if (await env.SESSIONS.get(`revoked-session:${id}`) === '1') await revokeD1Session(id, env)
  row = await env.AUTH_DB.prepare('SELECT data, revoked, expires_at FROM auth_sessions WHERE id = ?').bind(id).first<SessionRow>()
  return decode(row)
}

async function insertSession(id: string, session: SessionData, expiry: number, env: AuthEnv, importing = false): Promise<void> {
  await env.AUTH_DB.prepare(`INSERT INTO auth_sessions (id, data, email, google_sub, client_id, expires_at)
    VALUES (?, ?, ?, ?, ?, ?) ${importing ? 'ON CONFLICT(id) DO NOTHING' : ''}`)
    .bind(id, JSON.stringify(sanitizeSession(session)), null,
      session.google_sub ?? null, session.client_id ?? null, expiry).run()
}

export async function createD1Session(id: string, session: SessionData, env: AuthEnv): Promise<void> {
  await insertSession(id, session, Date.now() + SESSION_TTL * 1000, env)
}

const MUTABLE_SESSION_METADATA_FIELDS = new Set([
  'folder_id', 'changes_start_page_token', 's3_settings_negative_cache_at',
  's3_settings_file_id', 's3_status_file_id', 's3_status_negative_cache_at',
])

export async function saveD1Session(id: string, session: SessionData, env: AuthEnv): Promise<void> {
  // Persist only metadata whose values change during ordinary Drive/S3 requests.
  // Identity metadata is established by the OAuth callback and is immutable here.
  const safe = sanitizeSession(session)
  // Include every mutable key so `undefined` in the caller clears stale metadata
  // (notably folder-scoped Drive file IDs after account-folder reconciliation).
  const patch = Object.fromEntries([...MUTABLE_SESSION_METADATA_FIELDS].map(key => [key, (safe as Record<string, unknown>)[key] ?? null]))
  const now = Date.now()
  const row = await env.AUTH_DB.prepare(`UPDATE auth_sessions SET
    data = json_set(json_patch(data, ?), '$.renewed_at', MAX(COALESCE(json_extract(data, '$.renewed_at'), 0), ?)),
    expires_at = MAX(expires_at, ?)
    WHERE id = ? AND revoked = 0 AND expires_at > ? RETURNING data`)
    .bind(JSON.stringify(patch), session.renewed_at ?? 0, now + SESSION_TTL * 1000, id, now).first<{ data: string }>()
  if (!row) throw new SessionRevokedError('Session revoked or expired')
  adopt(session, JSON.parse(row.data) as SessionData)
}

export async function isD1SessionRevoked(id: string, env: AuthEnv): Promise<boolean> {
  const row = await env.AUTH_DB.prepare('SELECT revoked, expires_at FROM auth_sessions WHERE id = ?').bind(id).first<{ revoked: number; expires_at: number }>()
  return !row || row.revoked !== 0 || row.expires_at <= Date.now() || await revokedDuringCutover(id, env)
}

export async function revokeD1Session(id: string, env: AuthEnv): Promise<void> {
  // Keep a credential-free tombstone through the legacy import window. Updates
  // are update-only, so delayed refreshes cannot recreate even a cleaned-up row.
  const until = Math.max(Date.now() + SESSION_TTL * 1000, Date.parse(env.AUTH_KV_FALLBACK_UNTIL ?? '') || 0)
  await env.AUTH_DB.prepare(`INSERT INTO auth_sessions (id, data, expires_at, revoked) VALUES (?, NULL, ?, 1)
    ON CONFLICT(id) DO UPDATE SET data = NULL, email = NULL, google_sub = NULL, client_id = NULL, revoked = 1, expires_at = MAX(expires_at, excluded.expires_at), refresh_owner = NULL, refresh_until = 0`)
    .bind(id, until).run()
}

export async function revokeD1Account(field: "email" | "google_sub", value: string, env: AuthEnv): Promise<void> {
  const until = Date.now() + SESSION_TTL * 1000
  await env.AUTH_DB.prepare(`UPDATE auth_sessions SET data = NULL, email = NULL, google_sub = NULL, client_id = NULL, revoked = 1, expires_at = MAX(expires_at, ?), refresh_owner = NULL, refresh_until = 0
    WHERE ${field} = ? AND revoked = 0`).bind(until, field === "email" ? value.trim().toLowerCase() : value).run()
}

export async function saveOAuthState(state: string, data: string, env: Env): Promise<void> {
  if (!env.AUTH_DB) {
    await env.SESSIONS.put(`oauth_state:${state}`, data, { expirationTtl: OAUTH_STATE_TTL })
    return
  }
  await env.AUTH_DB.prepare('INSERT INTO auth_oauth_states (id, data, expires_at) VALUES (?, ?, ?)')
    .bind(state, data, Date.now() + OAUTH_STATE_TTL * 1000).run()
}

export async function consumeOAuthState(state: string, env: Env): Promise<string | null> {
  if (!env.AUTH_DB) {
    const raw = await env.SESSIONS.get(`oauth_state:${state}`)
    if (raw) await env.SESSIONS.delete(`oauth_state:${state}`)
    return raw
  }
  if (legacyAuthEnabled(env)) {
    const exists = await env.AUTH_DB.prepare('SELECT id FROM auth_oauth_states WHERE id = ?').bind(state).first()
    if (!exists) {
      const raw = await env.SESSIONS.get(`oauth_state:${state}`)
      if (raw) await env.AUTH_DB.prepare('INSERT INTO auth_oauth_states (id, data, expires_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING')
        .bind(state, raw, Date.now() + OAUTH_STATE_TTL * 1000).run()
    }
  }
  // Keep consumed records until expiry so a legacy KV value cannot be replayed.
  const row = await env.AUTH_DB.prepare('UPDATE auth_oauth_states SET consumed = 1 WHERE id = ? AND consumed = 0 AND expires_at > ? RETURNING data')
    .bind(state, Date.now()).first<{ data: string }>()
  return row?.data ?? null
}

export async function cleanupAuth(env: AuthEnv): Promise<void> {
  const now = Date.now()
  // Bounded deletes keep cron work and index write counts predictable.
  await env.AUTH_DB.batch([
    env.AUTH_DB.prepare('DELETE FROM auth_oauth_states WHERE id IN (SELECT id FROM auth_oauth_states WHERE expires_at <= ? LIMIT 500)').bind(now),
    env.AUTH_DB.prepare('DELETE FROM auth_sessions WHERE id IN (SELECT id FROM auth_sessions WHERE expires_at <= ? LIMIT 500)').bind(now),
  ])
  await purgeLegacyCredentialSessions(env)
  await purgeLegacyEmailIndexes(env)
}

async function purgeLegacyEmailIndexes(env: Env): Promise<void> {
  const cursorKey = 'legacy_email_index_purge_cursor'
  const cursor = await env.SESSIONS.get(cursorKey) ?? undefined
  const listing = await env.SESSIONS.list({ prefix: 'esidx:', limit: 500, cursor })
  await Promise.all(listing.keys.map(key => env.SESSIONS.delete(key.name)))
  if (listing.list_complete || !listing.cursor) await env.SESSIONS.delete(cursorKey)
  else await env.SESSIONS.put(cursorKey, listing.cursor, { expirationTtl: SESSION_TTL })
}

export async function purgeLegacyCredentialSessions(env: Env): Promise<void> {
  // Old deployments kept complete OAuth sessions in KV. Scheduled cleanup removes
  // at most one bounded page per run and retains an opaque cursor so safe newer
  // metadata rows at the start of the prefix cannot starve older credential rows.
  const cursorKey = 'legacy_session_purge_cursor'
  const cursor = await env.SESSIONS.get(cursorKey) ?? undefined
  const listing = await env.SESSIONS.list({ prefix: 'session:', limit: 500, cursor })
  await Promise.all(listing.keys.map(async key => {
    const raw = await env.SESSIONS.get(key.name)
    if (!raw) return
    try {
      const parsed = JSON.parse(raw) as SessionData
      const safe = sanitizeSession(parsed)
      if (Object.keys(parsed).some(field => !Object.hasOwn(safe, field))) {
        await env.SESSIONS.delete(key.name)
      }
    } catch {
      await env.SESSIONS.delete(key.name)
    }
  }))
  if (listing.list_complete || !listing.cursor) {
    await env.SESSIONS.delete(cursorKey)
  } else {
    await env.SESSIONS.put(cursorKey, listing.cursor, { expirationTtl: SESSION_TTL })
  }
}
