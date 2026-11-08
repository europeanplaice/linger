import { describe, expect, it, vi } from 'vitest'
import {
  parseSessionId, getSession, saveSession, getValidAccessToken, getValidIdToken,
  makeSessionCookie, clearSessionCookie, jsonResponse,
  removeEmailSessionIndex, invalidateSession,
} from '../../functions/_shared/session'
import { sessionStorageId } from '../../functions/_shared/authStore'
import { createPasskeyTestEnv } from '../helpers/passkeyAuth'

describe('jsonResponse', () => {
  it('marks JSON responses as non-cacheable with security headers', () => {
    const response = jsonResponse({ ok: true })
    expect(response.headers.get('Content-Type')).toBe('application/json')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })
})

describe('parseSessionId', () => {
  const request = (cookie?: string) => new Request('http://localhost', { headers: cookie ? { Cookie: cookie } : {} })
  it('extracts the session cookie', () => expect(parseSessionId(request('linger_session=abc123; other=val'))).toBe('abc123'))
  it('returns null when the cookie is missing or empty', () => {
    expect(parseSessionId(request())).toBeNull()
    expect(parseSessionId(request('linger_session=; other=val'))).toBeNull()
    expect(parseSessionId(request('other=val'))).toBeNull()
  })
  it('decodes URI-encoded session IDs', () => expect(parseSessionId(request('linger_session=hello%20world'))).toBe('hello world'))
})

describe('encrypted passkey session storage', () => {
  it('requires a passkey session and the user key to read encrypted account metadata', async () => {
    const { env, db, sessionId, userId, key } = await createPasskeyTestEnv({ google_sub: 'sub-1', folder_id: 'folder-1' })
    expect(await getSession(sessionId, env)).toBeNull()
    expect(await getSession('missing', env, key)).toBeNull()
    expect(await getSession(sessionId, env, 'invalid-key')).toBeNull()
    expect(await getSession(sessionId, env, key)).toMatchObject({ user_id: userId, google_sub: 'sub-1', folder_id: 'folder-1' })
    db.close()
  })

  it('encrypts metadata updates and never persists request credentials or raw session JSON', async () => {
    const { env, db, sessionId, userId, key } = await createPasskeyTestEnv({ google_sub: 'sub-1', folder_id: 'folder-1' })
    const session = await getSession(sessionId, env, key)
    expect(session).not.toBeNull()
    Object.assign(session!, {
      folder_id: 'folder-next', access_token: 'sensitive-access', id_token: 'sensitive-id',
      refresh_token: 'legacy-refresh', expires_at: Date.now() + 60_000,
    })
    await saveSession(sessionId, session!, env)
    const row = db.prepare('SELECT data FROM auth_sessions WHERE id = ?').get(await sessionStorageId(sessionId)) as { data: null }
    expect(row.data).toBeNull()
    const profile = db.prepare('SELECT account_envelope FROM passkey_users WHERE id = ?').get(userId) as { account_envelope: string }
    expect(profile.account_envelope).toMatch(/^v1\./)
    expect(profile.account_envelope).not.toContain('sensitive-access')
    expect(profile.account_envelope).not.toContain('sensitive-id')
    expect(profile.account_envelope).not.toContain('legacy-refresh')
    db.close()
  })

  it('never restores legacy KV session payloads', async () => {
    const get = vi.fn().mockResolvedValue(JSON.stringify({ access_token: 'old-token', google_sub: 'sub' }))
    expect(await getSession('legacy', { SESSIONS: { get } } as never)).toBeNull()
    expect(get).not.toHaveBeenCalled()
  })
})

describe('request-scoped Google credentials', () => {
  it('returns a still-valid access token supplied on this request without writing it to KV', async () => {
    const put = vi.fn()
    const session = { access_token: 'request-access', expires_at: Date.now() + 120_000 }
    expect(await getValidAccessToken('sid', session, { SESSIONS: { get: vi.fn(), put } } as never)).toBe('request-access')
    expect(put).not.toHaveBeenCalled()
  })

  it('rejects absent or expired access tokens instead of refreshing from stored credentials', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const env = { SESSIONS: { get: vi.fn(), put: vi.fn() } }
    await expect(getValidAccessToken('sid', { access_token: 'expired', expires_at: Date.now() - 1 }, env as never)).rejects.toThrow(/request-scoped/)
    await expect(getValidAccessToken('sid', {}, env as never)).rejects.toThrow(/request-scoped/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('returns only a verified ID token present on this request', async () => {
    const env = { SESSIONS: { get: vi.fn(), put: vi.fn() } }
    const valid = { access_token: 'at', expires_at: Date.now() + 120_000, id_token: 'id', id_token_verified: true }
    expect(await getValidIdToken('sid', valid, env as never)).toBe('id')
    expect(await getValidIdToken('sid', { ...valid, id_token_verified: false }, env as never)).toBeNull()
  })

  it('does not return an ID token when the request access token is expired', async () => {
    const env = { SESSIONS: { get: vi.fn(), put: vi.fn() } }
    await expect(getValidIdToken('sid', { access_token: 'at', expires_at: Date.now() - 1, id_token: 'id', id_token_verified: true }, env as never)).rejects.toThrow(/request-scoped/)
  })
})

describe('session cookies', () => {
  it('creates a secure HttpOnly session cookie', () => {
    const cookie = makeSessionCookie('abc123', 3600, true)
    expect(cookie).toContain('linger_session=abc123')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=Strict')
    expect(cookie).toContain('Path=/')
    expect(cookie).toContain('Max-Age=3600')
  })
  it('encodes IDs and clears the cookie with Max-Age=0', () => {
    expect(makeSessionCookie('a b', 3600)).toContain('linger_session=a%20b')
    expect(clearSessionCookie()).toContain('Max-Age=0')
    expect(clearSessionCookie(false)).not.toContain('Secure')
    expect(makeSessionCookie('sid', 1, false)).not.toContain('Secure')
  })
})

describe('session indexes and revocation', () => {
  it('does not create or remove Google identifier indexes', async () => {
    const del = vi.fn()
    const env = { SESSIONS: { delete: del }, AUTH_DB: {} }
    await removeEmailSessionIndex('user@example.com', 'sid', env as never)
    expect(del).not.toHaveBeenCalled()
  })

  it('revokes by opaque session digest without touching KV identity indexes', async () => {
    const { env, db, sessionId, userId, kv } = await createPasskeyTestEnv()
    await invalidateSession(sessionId, undefined, env)
    expect(db.prepare('SELECT user_id, data, revoked FROM auth_sessions WHERE id = ?').get(await sessionStorageId(sessionId)))
      .toEqual({ user_id: null, data: null, revoked: 1 })
    expect(db.prepare('SELECT id FROM passkey_users WHERE id = ?').get(userId)).toEqual({ id: userId })
    expect(kv.size()).toBe(0)
    db.close()
  })
})
