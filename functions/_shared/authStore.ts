import type { Env, SessionData } from './session'
import { OAUTH_STATE_TTL, SESSION_TTL, SessionRevokedError } from './session'

type AuthEnv = Env & { AUTH_DB: D1Database }
interface SessionRow { data: string | null; revoked: number; expires_at: number }

// No Sessions API/read replicas here: logout and RISC must see primary state.
export function legacyAuthEnabled(env: Env): boolean {
  const deadline = Date.parse(env.AUTH_KV_FALLBACK_UNTIL ?? '')
  return Number.isFinite(deadline) && Date.now() < deadline
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
  try { return JSON.parse(row.data) as SessionData } catch { return null }
}

function adopt(session: SessionData, fresh: SessionData): void {
  for (const key of Object.keys(session)) Reflect.deleteProperty(session, key)
  Object.assign(session, fresh)
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
    .bind(id, JSON.stringify(session), session.email?.trim().toLowerCase() ?? null,
      session.google_sub ?? null, session.client_id ?? null, expiry).run()
}

export async function createD1Session(id: string, session: SessionData, env: AuthEnv): Promise<void> {
  await insertSession(id, session, Date.now() + SESSION_TTL * 1000, env)
}

const TOKEN_FIELDS = new Set(['refresh_token', 'access_token', 'expires_at', 'id_token', 'id_token_verified', 'client_id', 'email', 'google_sub'])

export async function saveD1Session(id: string, session: SessionData, env: AuthEnv): Promise<void> {
  // Ordinary metadata/TTL writes cannot roll back a token refreshed by another
  // request. Tokens can only be changed by the holder of the refresh lease.
  const patch = Object.fromEntries(Object.entries(session).filter(([key]) => !TOKEN_FIELDS.has(key)).map(([key, value]) => [key, value ?? null]))
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
    ON CONFLICT(id) DO UPDATE SET data = NULL, revoked = 1, expires_at = MAX(expires_at, excluded.expires_at), refresh_owner = NULL, refresh_until = 0`)
    .bind(id, until).run()
}

export async function findD1RefreshToken(field: 'email' | 'google_sub', value: string, clientId: string, sub: string, env: AuthEnv): Promise<string | null> {
  const row = await env.AUTH_DB.prepare(`SELECT json_extract(data, '$.refresh_token') AS token FROM auth_sessions
    WHERE ${field} = ? AND google_sub = ? AND client_id = ? AND revoked = 0 AND expires_at > ?
    AND json_extract(data, '$.refresh_token') IS NOT NULL LIMIT 1`)
    .bind(field === 'email' ? value.trim().toLowerCase() : value, sub, clientId, Date.now()).first<{ token: string }>()
  return row?.token ?? null
}

export async function revokeD1Account(field: 'email' | 'google_sub', value: string, env: AuthEnv): Promise<void> {
  const until = Math.max(Date.now() + SESSION_TTL * 1000, Date.parse(env.AUTH_KV_FALLBACK_UNTIL ?? '') || 0)
  await env.AUTH_DB.prepare(`UPDATE auth_sessions SET data = NULL, revoked = 1, expires_at = MAX(expires_at, ?), refresh_owner = NULL, refresh_until = 0
    WHERE ${field} = ? AND revoked = 0`).bind(until, field === 'email' ? value.trim().toLowerCase() : value).run()
}

export async function refreshD1Session(id: string, session: SessionData, env: AuthEnv, force: boolean,
  refresh: (owner: string) => Promise<SessionData>): Promise<SessionData> {
  const originalToken = session.access_token
  const originalExpiry = session.expires_at
  const originalIdToken = session.id_token
  // A bounded wait: a slow refresh returns a retryable error to its waiters.
  for (let attempt = 0; attempt < 12; attempt++) {
    const fresh = await readD1Session(id, env)
    if (!fresh) throw new SessionRevokedError('Session revoked or expired')
    const changed = fresh.access_token !== originalToken || fresh.expires_at !== originalExpiry || fresh.id_token !== originalIdToken
    if (fresh.expires_at > Date.now() + 60_000 && (!force || changed)) {
      adopt(session, fresh)
      return session
    }
    const owner = crypto.randomUUID()
    const now = Date.now()
    const lease = await env.AUTH_DB.prepare(`UPDATE auth_sessions SET refresh_owner = ?, refresh_until = ?
      WHERE id = ? AND revoked = 0 AND expires_at > ? AND refresh_until <= ?
      AND json_extract(data, '$.access_token') = ? AND json_extract(data, '$.expires_at') = ?`)
      .bind(owner, now + 90_000, id, now, now, fresh.access_token, fresh.expires_at).run()
    if (lease.meta.changes) {
      adopt(session, fresh)
      try { return await refresh(owner) }
      finally {
        await env.AUTH_DB.prepare('UPDATE auth_sessions SET refresh_owner = NULL, refresh_until = 0 WHERE id = ? AND refresh_owner = ?')
          .bind(id, owner).run()
      }
    }
    await new Promise(resolve => setTimeout(resolve, 200 + Math.random() * 200))
  }
  throw new Error('Token refresh is already in progress')
}

export async function finishD1Refresh(id: string, session: SessionData, owner: string, env: AuthEnv): Promise<void> {
  const tokens = Object.fromEntries([...TOKEN_FIELDS].filter(key => key !== 'email' && key !== 'google_sub').map(key => [key, session[key as keyof SessionData] ?? null]))
  const now = Date.now()
  const row = await env.AUTH_DB.prepare(`UPDATE auth_sessions SET data = json_patch(data, ?), expires_at = MAX(expires_at, ?)
    WHERE id = ? AND refresh_owner = ? AND revoked = 0 AND expires_at > ? RETURNING data`)
    .bind(JSON.stringify(tokens), now + SESSION_TTL * 1000, id, owner, now).first<{ data: string }>()
  if (!row) {
    if (await isD1SessionRevoked(id, env)) throw new SessionRevokedError('Session revoked or expired')
    throw new Error('Session refresh lease lost')
  }
  adopt(session, JSON.parse(row.data) as SessionData)
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
}
