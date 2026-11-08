import type { Env, SessionData } from './session'
import { OAUTH_STATE_TTL, SESSION_TTL, SessionRevokedError } from './session'
import { openVaultValue, sealVaultValue, validVaultKey } from './vaultCrypto'

type AuthEnv = Env & { AUTH_DB: D1Database }
interface SessionRow {
  user_id: string | null
  revoked: number
  expires_at: number
  account_envelope: string | null
  revision: number
}
const SESSION_ID_HASH_PREFIX = 'sha256:'
const PROFILE_PURPOSE = 'account-metadata'
const SESSION_SELECT = `SELECT s.user_id, s.revoked, s.expires_at, u.account_envelope, u.revision
  FROM auth_sessions s LEFT JOIN passkey_users u ON u.id = s.user_id WHERE s.id = ?`

export async function sessionStorageId(id: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id)))
  return SESSION_ID_HASH_PREFIX + Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function durableSessionHandle(id: string, env: Env): Promise<string> {
  void env
  return /^sha256:[0-9a-f]{64}$/.test(id) ? id : sessionStorageId(id)
}

export function legacyAuthEnabled(env: Env): boolean {
  void env
  return false
}

// Authentication uses the signed passkey and an opaque session, not a decrypted
// Google identifier. A storage digest is never accepted as a caller cookie.
export async function getPasskeySessionUserId(id: string, env: Env): Promise<string | null> {
  if (!env.AUTH_DB || id.startsWith(SESSION_ID_HASH_PREFIX)) return null
  const row = await env.AUTH_DB.prepare('SELECT user_id FROM auth_sessions WHERE id = ? AND revoked = 0 AND expires_at > ?')
    .bind(await sessionStorageId(id), Date.now()).first<{ user_id: string | null }>()
  return row?.user_id ?? null
}

export async function createPasskeySession(id: string, userId: string, env: Env): Promise<void> {
  if (!env.AUTH_DB || !userId || id.startsWith(SESSION_ID_HASH_PREFIX)) throw new SessionRevokedError('Passkey authentication required')
  await env.AUTH_DB.prepare('INSERT INTO auth_sessions (id, user_id, data, expires_at) VALUES (?, ?, NULL, ?)')
    .bind(await sessionStorageId(id), userId, Date.now() + SESSION_TTL * 1000).run()
}

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

async function decode(row: SessionRow | null, key?: string): Promise<SessionData | null> {
  if (!row?.user_id || row.revoked || row.expires_at <= Date.now() || !validVaultKey(key)) return null
  try {
    const profile = row.account_envelope
      ? await openVaultValue<SessionData>(key, row.user_id, PROFILE_PURPOSE, row.account_envelope)
      : {}
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return null
    const safe = sanitizeSession(profile)
    return { ...safe, user_id: row.user_id, vault_key: key, vault_snapshot: { ...safe } }
  } catch { return null }
}

export async function readD1Session(id: string, env: AuthEnv, key?: string): Promise<SessionData | null> {
  if (id.startsWith(SESSION_ID_HASH_PREFIX)) return null
  return decode(await env.AUTH_DB.prepare(SESSION_SELECT).bind(await sessionStorageId(id)).first<SessionRow>(), key)
}

export async function readD1SessionByStorageId(id: string, env: AuthEnv, key?: string): Promise<SessionData | null> {
  if (!/^sha256:[0-9a-f]{64}$/.test(id)) return null
  return decode(await env.AUTH_DB.prepare(SESSION_SELECT).bind(id).first<SessionRow>(), key)
}

export async function createD1Session(id: string, session: SessionData, env: AuthEnv): Promise<void> {
  if (!session.user_id) throw new SessionRevokedError('Passkey authentication required')
  await createPasskeySession(id, session.user_id, env)
  if (validVaultKey(session.vault_key)) await saveD1Session(id, session, env)
}

export async function saveD1Session(id: string, session: SessionData, env: AuthEnv): Promise<void> {
  if (id.startsWith(SESSION_ID_HASH_PREFIX) || !session.user_id || !validVaultKey(session.vault_key)) {
    throw new SessionRevokedError('Vault unlock required')
  }
  const key = session.vault_key
  const storageId = await sessionStorageId(id)
  const safe = sanitizeSession(session)
  const baseline = session.vault_snapshot ?? {}
  const fields = new Set([...Object.keys(baseline), ...Object.keys(safe)])
  const changes = [...fields].filter(field => !Object.is(
    (baseline as Record<string, unknown>)[field], (safe as Record<string, unknown>)[field],
  ))
  // Optimistic profile updates merge only fields changed by this request. This
  // keeps independent tabs from clobbering each other's Drive metadata.
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await env.AUTH_DB.prepare(SESSION_SELECT).bind(storageId).first<SessionRow>()
    if (row?.user_id !== session.user_id) throw new SessionRevokedError('Session revoked or expired')
    const fresh = await decode(row, key)
    if (!fresh) throw new SessionRevokedError('Vault unlock required')
    if (fresh.google_sub && safe.google_sub && fresh.google_sub !== safe.google_sub) throw new SessionRevokedError('Google account changed')
    const merged = sanitizeSession(fresh) as Record<string, unknown>
    for (const field of changes) {
      if ((field === 'google_sub' || field === 'client_id') && merged[field] !== undefined && merged[field] !== (safe as Record<string, unknown>)[field]) {
        throw new SessionRevokedError('Google account changed')
      }
      const value = (safe as Record<string, unknown>)[field]
      if (value === undefined) delete merged[field]
      else merged[field] = value
    }
    const envelope = await sealVaultValue(key, session.user_id, PROFILE_PURPOSE, merged)
    const updated = await env.AUTH_DB.prepare(`UPDATE passkey_users SET account_envelope = ?, revision = revision + 1
      WHERE id = ? AND revision = ? AND EXISTS (
        SELECT 1 FROM auth_sessions WHERE id = ? AND user_id = passkey_users.id AND revoked = 0 AND expires_at > ?
      ) RETURNING revision`)
      .bind(envelope, session.user_id, row.revision, storageId, Date.now()).first<{ revision: number }>()
    if (!updated) continue
    const renewed = await env.AUTH_DB.prepare('UPDATE auth_sessions SET expires_at = MAX(expires_at, ?) WHERE id = ? AND revoked = 0 AND expires_at > ? RETURNING id')
      .bind(Date.now() + SESSION_TTL * 1000, storageId, Date.now()).first()
    if (!renewed) throw new SessionRevokedError('Session revoked or expired')
    // Retain only safe profile values and request-local credentials/key.
    for (const field of Object.keys(sanitizeSession(session))) Reflect.deleteProperty(session, field)
    Object.assign(session, merged, { vault_snapshot: { ...merged } })
    return
  }
  throw new Error('Account metadata changed; retry the request')
}

export async function isD1SessionRevoked(id: string, env: AuthEnv): Promise<boolean> {
  return !await getPasskeySessionUserId(id, env)
}

export async function revokeD1Session(id: string, env: AuthEnv): Promise<void> {
  if (id.startsWith(SESSION_ID_HASH_PREFIX)) throw new SessionRevokedError('Invalid session identifier')
  await env.AUTH_DB.prepare('UPDATE auth_sessions SET data = NULL, user_id = NULL, revoked = 1 WHERE id = ?')
    .bind(await sessionStorageId(id)).run()
}

// A Google-sub lookup index would undo the privacy boundary. A verified RISC
// event conservatively revokes all sessions rather than retaining that index.
export async function revokeD1Account(field: 'email' | 'google_sub', value: string, env: AuthEnv): Promise<void> {
  void field
  void value
  await env.AUTH_DB.prepare('UPDATE auth_sessions SET data = NULL, user_id = NULL, revoked = 1 WHERE revoked = 0').run()
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
  await purgeLegacySubjectIndexes(env)
  await purgeLegacyOAuthStates(env)
}

async function purgeLegacyEmailIndexes(env: Env): Promise<void> {
  await purgeLegacyPrefix(env, 'esidx:', 'legacy_email_index_purge_cursor')
}

async function purgeLegacySubjectIndexes(env: Env): Promise<void> {
  await purgeLegacyPrefix(env, 'ssidx:', 'legacy_subject_index_purge_cursor')
}

async function purgeLegacyOAuthStates(env: Env): Promise<void> {
  await purgeLegacyPrefix(env, 'oauth_state:', 'legacy_oauth_state_purge_cursor')
}

async function purgeLegacyPrefix(env: Env, prefix: string, cursorKey: string): Promise<void> {
  const cursor = await env.SESSIONS.get(cursorKey) ?? undefined
  const listing = await env.SESSIONS.list({ prefix, limit: 500, cursor })
  await Promise.all(listing.keys.map(key => env.SESSIONS.delete(key.name)))
  if (listing.list_complete || !listing.cursor) await env.SESSIONS.delete(cursorKey)
  else await env.SESSIONS.put(cursorKey, listing.cursor, { expirationTtl: SESSION_TTL })
}

export async function purgeLegacyCredentialSessions(env: Env): Promise<void> {
  // KV session storage is retired. Delete every row without reading or parsing
  // it; even older metadata-only payloads can contain plaintext Google IDs.
  await purgeLegacyPrefix(env, 'session:', 'legacy_session_purge_cursor')
}
