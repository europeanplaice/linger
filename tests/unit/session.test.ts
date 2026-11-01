import { describe, expect, it, vi } from 'vitest'
import {
  parseSessionId, getSession, saveSession, getValidAccessToken, getValidIdToken,
  makeSessionCookie, clearSessionCookie, jsonResponse,
  removeEmailSessionIndex, invalidateSession, SESSION_TTL,
} from '../../functions/_shared/session'

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

describe('session storage', () => {
  it('reads valid session metadata and rejects invalid or absent records', async () => {
    const valid = { email: 'user@example.com', google_sub: 'sub-1', folder_id: 'folder-1' }
    const env = { SESSIONS: { get: vi.fn(async (key: string) => key === 'session:valid' ? JSON.stringify(valid) : key === 'session:bad' ? 'not-json' : null) } }
    expect(await getSession('valid', env as any)).toEqual({ google_sub: 'sub-1', folder_id: 'folder-1' })
    expect(await getSession('bad', env as any)).toBeNull()
    expect(await getSession('missing', env as any)).toBeNull()
  })

  it('persists only the metadata allowlist, even when given request credentials', async () => {
    const put = vi.fn()
    const env = { SESSIONS: { get: vi.fn().mockResolvedValue(null), put } }
    await saveSession('sid', {
      email: 'user@example.com', google_sub: 'sub-1', folder_id: 'folder-1',
      access_token: 'sensitive-access', id_token: 'sensitive-id', refresh_token: 'legacy-refresh',
      expires_at: Date.now() + 60_000,
    } as any, env as any)
    expect(put).toHaveBeenCalledOnce()
    const stored = JSON.parse(put.mock.calls[0][1])
    expect(stored).toMatchObject({ google_sub: 'sub-1', folder_id: 'folder-1' })
    expect(stored).not.toHaveProperty('email')
    expect(stored).not.toHaveProperty('access_token')
    expect(stored).not.toHaveProperty('id_token')
    expect(stored).not.toHaveProperty('refresh_token')
    expect(stored).not.toHaveProperty('expires_at')
  })
})

describe('request-scoped Google credentials', () => {
  it('returns a still-valid access token supplied on this request without writing it to KV', async () => {
    const put = vi.fn()
    const session = { access_token: 'request-access', expires_at: Date.now() + 120_000 }
    expect(await getValidAccessToken('sid', session, { SESSIONS: { get: vi.fn(), put } } as any)).toBe('request-access')
    expect(put).not.toHaveBeenCalled()
  })

  it('rejects absent or expired access tokens instead of refreshing from stored credentials', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const env = { SESSIONS: { get: vi.fn(), put: vi.fn() } }
    await expect(getValidAccessToken('sid', { access_token: 'expired', expires_at: Date.now() - 1 } as any, env as any)).rejects.toThrow(/request-scoped/)
    await expect(getValidAccessToken('sid', {} as any, env as any)).rejects.toThrow(/request-scoped/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('returns only a verified ID token present on this request', async () => {
    const env = { SESSIONS: { get: vi.fn(), put: vi.fn() } }
    const valid = { access_token: 'at', expires_at: Date.now() + 120_000, id_token: 'id', id_token_verified: true }
    expect(await getValidIdToken('sid', valid as any, env as any)).toBe('id')
    expect(await getValidIdToken('sid', { ...valid, id_token_verified: false } as any, env as any)).toBeNull()
  })

  it('does not return an ID token when the request access token is expired', async () => {
    const env = { SESSIONS: { get: vi.fn(), put: vi.fn() } }
    await expect(getValidIdToken('sid', { access_token: 'at', expires_at: Date.now() - 1, id_token: 'id', id_token_verified: true } as any, env as any)).rejects.toThrow(/request-scoped/)
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
  it('removes the email index entry for one session', async () => {
    const del = vi.fn()
    await removeEmailSessionIndex('user@example.com', 'sid', { SESSIONS: { delete: del } } as any)
    expect(del).toHaveBeenCalledWith('esidx:user@example.com:sid')
  })
  it('marks the session revoked before deleting its record and identity index', async () => {
    const calls: string[] = []
    const env = { SESSIONS: {
      put: vi.fn(async (key: string) => { calls.push(`put:${key}`) }),
      delete: vi.fn(async (key: string) => { calls.push(`delete:${key}`) }),
    } }
    await invalidateSession('sid', 'user@example.com', env as any, 'sub-1')
    expect(calls).toEqual([
      'put:revoked-session:sid', 'delete:session:sid',
      'delete:esidx:user@example.com:sid', 'delete:ssidx:sub-1:sid',
    ])
  })
})
