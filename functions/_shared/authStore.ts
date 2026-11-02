import type { Env, SessionData } from './session'
import { OAUTH_STATE_TTL, SESSION_TTL, SessionRevokedError } from './session'

type AuthEnv = Env & { AUTH_DB: D1Database }
interface SessionRow { data: string | null; revoked: number; expires_at: number }

const SESSION_ID_HASH_PREFIX = 'sha256:'

// Session IDs are bearer credentials. Persist only a deterministic digest so
// server-side lookups remain possible without retaining the cookie value.
// Cookie lookups and durable retry handles use separate paths so a digest alone
// never authenticates a session.
export async function sessionStorageId(id: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id)))
  return SESSION_ID_HASH_PREFIX + Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
}

// Used only for trusted durable retry payloads that have already crossed a
// request authentication boundary. Cookie values must always use sessionStorageId.
export async function durableSessionHandle(id: string, env: Env): Promise<string> {
  if (id.startsWith(SESSION_ID_HASH_PREFIX)) return id
  if (!env.AUTH_DB) return id
  const hashed = await sessionStorageId(id)
  const hashedRow = await env.AUTH_DB.prepare('SELECT id FROM auth_sessions WHERE id = ?').bind(hashed).first()
  if (hashedRow) return hashed
  const legacyRow = await env.AUTH_DB.prepare('SELECT id FROM auth_sessions WHERE id = ?').bind(id).first()
  // A legacy raw primary key cannot be replaced while older Pages versions may
  // still read it. Retain that handle until the row expires; new sessions use
  // the hash immediately.
  return legacyRow ? id : hashed
}

async function findSessionRow(id: string, env: AuthEnv): Promise<{ storageId: string; row: SessionRow | null }> {
  const storageId = await sessionStorageId(id)
  let row = await env.AUTH_DB.prepare('SELECT data, revoked, expires_at FROM auth_sessions WHERE id = ?').bind(storageId).first<SessionRow>()
  if (row || id.startsWith(SESSION_ID_HASH_PREFIX)) return { storageId, row }
  // Read legacy rows written before hashed identifiers shipped. We deliberately
  // leave them in place until natural expiry so old workflow payloads and logout
  // requests remain valid through the rollout.
  row = await env.AUTH_DB.prepare('SELECT data, revoked, expires_at FROM auth_sessions WHERE id = ?').bind(id).first<SessionRow>()
  return { storageId: id, row }
}

export async function readD1SessionByStorageId(storageId: string, env: AuthEnv): Promise<SessionData | null> {
  if (!/^sha256:[0-9a-f]{64}$/.test(storageId)) return null
  const row = await env.AUTH_DB.prepare('SELECT data, revoked, expires_at FROM auth_sessions WHERE id = ?').bind(storageId).first<SessionRow>()
  return decode(row)
}

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
  let { row } = await findSessionRow(id, env)
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
  return decode((await findSessionRow(id, env)).row)
}

async function insertSession(id: string, session: SessionData, expiry: number, env: AuthEnv, importing = false): Promise<void> {
  const storageId = await sessionStorageId(id)
  await env.AUTH_DB.prepare(`INSERT INTO auth_sessions (id, data, email, google_sub, client_id, expires_at)
    VALUES (?, ?, ?, ?, ?, ?) ${importing ? 'ON CONFLICT(id) DO NOTHING' : ''}`)
    .bind(storageId, JSON.stringify(sanitizeSession(session)), null,
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
  const { storageId, row: existing } = await findSessionRow(id, env)
  // A digest presented as a cookie is deliberately not a storage handle. Do not
  // issue an UPDATE unless the caller's raw ID resolved through the hash or the
  // legacy raw-key lookup above.
  if (!existing) throw new SessionRevokedError('Session revoked or expired')
  const expiryUpdate = storageId === id ? 'expires_at = expires_at' : 'expires_at = MAX(expires_at, ?)'
  const row = await env.AUTH_DB.prepare(`UPDATE auth_sessions SET
    data = json_set(json_patch(data, ?), '$.renewed_at', MAX(COALESCE(json_extract(data, '$.renewed_at'), 0), ?)),
    ${expiryUpdate}
    WHERE id = ? AND revoked = 0 AND expires_at > ? RETURNING data`)
    .bind(...(storageId === id
      ? [JSON.stringify(patch), session.renewed_at ?? 0, storageId, now]
      : [JSON.stringify(patch), session.renewed_at ?? 0, now + SESSION_TTL * 1000, storageId, now])).first<{ data: string }>()
  if (!row) throw new SessionRevokedError('Session revoked or expired')
  adopt(session, JSON.parse(row.data) as SessionData)
}

export async function isD1SessionRevoked(id: string, env: AuthEnv): Promise<boolean> {
  const { row } = await findSessionRow(id, env)
  return !row || row.revoked !== 0 || row.expires_at <= Date.now() || await revokedDuringCutover(id, env)
}

export async function revokeD1Session(id: string, env: AuthEnv): Promise<void> {
  // Hashed storage IDs are internal lookup handles, never valid caller session
  // IDs. Refuse them here so this API cannot revoke a row by its stored key.
  if (id.startsWith(SESSION_ID_HASH_PREFIX)) throw new SessionRevokedError('Invalid session identifier')
  // Keep a credential-free tombstone through the legacy import window. Updates
  // are update-only, so delayed refreshes cannot recreate even a cleaned-up row.
  const until = Math.max(Date.now() + SESSION_TTL * 1000, Date.parse(env.AUTH_KV_FALLBACK_UNTIL ?? '') || 0)
  const storageId = await sessionStorageId(id)
  const statements = [env.AUTH_DB.prepare(`INSERT INTO auth_sessions (id, data, expires_at, revoked) VALUES (?, NULL, ?, 1)
    ON CONFLICT(id) DO UPDATE SET data = NULL, email = NULL, google_sub = NULL, client_id = NULL, revoked = 1, expires_at = MAX(expires_at, excluded.expires_at), refresh_owner = NULL, refresh_until = 0`)
    .bind(storageId, until)]
  if (storageId !== id) {
    // Revoke a pre-hash row too. This dual write is important during rollout:
    // an old worker may still be updating the legacy primary key. Run both
    // changes in one D1 batch so neither key remains active if one write fails.
    statements.push(env.AUTH_DB.prepare(`UPDATE auth_sessions SET data = NULL, email = NULL, google_sub = NULL, client_id = NULL, revoked = 1, expires_at = MAX(expires_at, ?), refresh_owner = NULL, refresh_until = 0 WHERE id = ?`)
      .bind(until, id))
  }
  await env.AUTH_DB.batch(statements)
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
  // DELETE ... RETURNING is the atomic one-time claim and immediately removes
  // the verifier/nonce payload. The legacy KV import path is disabled after the
  // D1 cutover, so there is no need to retain a consumed marker.
  const row = await env.AUTH_DB.prepare('DELETE FROM auth_oauth_states WHERE id = ? AND consumed = 0 AND expires_at > ? RETURNING data')
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
