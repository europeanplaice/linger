import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  parseSessionId, getSession, saveSession, getValidAccessToken,
  makeSessionCookie, clearSessionCookie, jsonResponse,
  addEmailSessionIndex, removeEmailSessionIndex, deleteAllSessionsForEmail,
  getRefreshTokenForEmail, invalidateSession,
  SESSION_TTL,
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
  function mockRequest(cookie?: string): Request {
    return new Request('http://localhost', {
      headers: cookie ? { Cookie: cookie } : {},
    })
  }

  it('extracts session cookie from Cookie header', () => {
    expect(parseSessionId(mockRequest('linger_session=abc123; other=val'))).toBe('abc123')
  })

  it('returns null when no Cookie header', () => {
    expect(parseSessionId(mockRequest())).toBeNull()
  })

  it('returns null when session cookie value is empty', () => {
    expect(parseSessionId(mockRequest('linger_session=; other=val'))).toBeNull()
  })

  it('returns null when session cookie is absent', () => {
    expect(parseSessionId(mockRequest('other=val'))).toBeNull()
  })

  it('decodes URI-encoded session ID', () => {
    expect(parseSessionId(mockRequest('linger_session=hello%20world'))).toBe('hello world')
  })
})

describe('getSession', () => {
  it('returns parsed session when KV has a value', async () => {
    const sessionData = { refresh_token: 'rt', access_token: 'at', expires_at: 1000 }
    const env = { SESSIONS: { get: vi.fn().mockResolvedValue(JSON.stringify(sessionData)) } }
    expect(await getSession('sid', env as any)).toEqual(sessionData)
  })

  it('returns null when KV returns null', async () => {
    const env = { SESSIONS: { get: vi.fn().mockResolvedValue(null) } }
    expect(await getSession('sid', env as any)).toBeNull()
  })

  it('returns null when stored JSON is invalid', async () => {
    const env = { SESSIONS: { get: vi.fn().mockResolvedValue('not-json') } }
    expect(await getSession('sid', env as any)).toBeNull()
  })
})

describe('saveSession', () => {
  it('writes session JSON to KV with 30-day TTL', async () => {
    const put = vi.fn()
    const env = { SESSIONS: { put } }
    const session = { refresh_token: 'rt', access_token: 'at', expires_at: 1000 }
    await saveSession('sid', session, env as any)
    expect(put).toHaveBeenCalledWith('session:sid', JSON.stringify(session), { expirationTtl: 60 * 60 * 24 * 30 })
  })
})

describe('makeSessionCookie', () => {
  it('creates a secure HttpOnly session cookie', () => {
    const cookie = makeSessionCookie('abc123', 3600, true)
    expect(cookie).toContain('linger_session=abc123')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=Strict')
    expect(cookie).toContain('Path=/')
    expect(cookie).toContain('Max-Age=3600')
  })

  it('omits Secure flag when secure=false', () => {
    expect(makeSessionCookie('abc123', 3600, false)).not.toContain('Secure')
  })

  it('encodes the session ID', () => {
    expect(makeSessionCookie('a b', 3600)).toContain('linger_session=a%20b')
  })
})

describe('clearSessionCookie', () => {
  it('creates a cookie with Max-Age=0', () => {
    const cookie = clearSessionCookie(true)
    expect(cookie).toContain('linger_session=')
    expect(cookie).toContain('Max-Age=0')
    expect(cookie).toContain('Secure')
  })

  it('omits Secure flag when secure=false', () => {
    expect(clearSessionCookie(false)).not.toContain('Secure')
  })
})

describe('getValidAccessToken', () => {
  const baseEnv = { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('returns current access token when not expired', async () => {
    const session = { refresh_token: 'rt', access_token: 'at', expires_at: Date.now() + 120_000 }
    const result = await getValidAccessToken('sid', session, baseEnv as any)
    expect(result).toBe('at')
  })

  it('does not write to KV when token is still valid', async () => {
    const put = vi.fn()
    const env = { ...baseEnv, SESSIONS: { put } }
    const session = { refresh_token: 'rt', access_token: 'at', expires_at: Date.now() + 120_000 }

    await getValidAccessToken('sid', session, env as any)

    expect(put).not.toHaveBeenCalled()
  })

  it('refreshes token when expired and stores the new token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'new_at', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    ))
    const put = vi.fn()
    const env = { ...baseEnv, SESSIONS: { put } }
    const session = { refresh_token: 'rt', access_token: 'old_at', expires_at: Date.now() - 60_000 }

    const result = await getValidAccessToken('sid', session, env as any)

    expect(result).toBe('new_at')
    expect(put).toHaveBeenCalledOnce()
    const stored = JSON.parse(put.mock.calls[0][1])
    expect(stored.access_token).toBe('new_at')
    expect(stored.refresh_token).toBe('rt')
    expect(stored.client_id).toBe('id')
  })

  it('throws when token refresh fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('Unauthorized', { status: 401 })
    ))
    const session = { refresh_token: 'rt', access_token: 'old_at', expires_at: Date.now() - 60_000 }

    await expect(getValidAccessToken('sid', session, baseEnv as any)).rejects.toThrow('Token refresh failed: 401')
  })
})

describe('addEmailSessionIndex', () => {
  it('creates a new index entry with the session ID', async () => {
    const get = vi.fn().mockResolvedValue(null)
    const put = vi.fn()
    const env = { SESSIONS: { get, put } }
    await addEmailSessionIndex('user@example.com', 'sid1', env as any)
    expect(put).toHaveBeenCalledWith('email_sessions:user@example.com', JSON.stringify(['sid1']), { expirationTtl: SESSION_TTL })
  })

  it('appends to an existing index', async () => {
    const get = vi.fn().mockResolvedValue(JSON.stringify(['sid1']))
    const put = vi.fn()
    const env = { SESSIONS: { get, put } }
    await addEmailSessionIndex('user@example.com', 'sid2', env as any)
    expect(put).toHaveBeenCalledWith('email_sessions:user@example.com', JSON.stringify(['sid1', 'sid2']), { expirationTtl: SESSION_TTL })
  })

  it('does not duplicate an already-indexed session ID', async () => {
    const get = vi.fn().mockResolvedValue(JSON.stringify(['sid1']))
    const put = vi.fn()
    const env = { SESSIONS: { get, put } }
    await addEmailSessionIndex('user@example.com', 'sid1', env as any)
    expect(put).not.toHaveBeenCalled()
  })
})

describe('getRefreshTokenForEmail', () => {
  it('returns null when no index exists for the email', async () => {
    const get = vi.fn().mockResolvedValue(null)
    const env = { SESSIONS: { get } }
    expect(await getRefreshTokenForEmail('user@example.com', 'client-a', env as any)).toBeNull()
  })

  it('returns the refresh_token from the first session matching the current client', async () => {
    const get = vi.fn().mockImplementation((key: string) => {
      if (key === 'email_sessions:user@example.com') return Promise.resolve(JSON.stringify(['sid1']))
      if (key === 'session:sid1') return Promise.resolve(JSON.stringify({ refresh_token: 'rt1', access_token: 'at', expires_at: 0, client_id: 'client-a' }))
      return Promise.resolve(null)
    })
    const env = { SESSIONS: { get } }
    expect(await getRefreshTokenForEmail('user@example.com', 'client-a', env as any)).toBe('rt1')
  })

  it('skips sessions without a refresh_token and returns the first one that has it', async () => {
    const get = vi.fn().mockImplementation((key: string) => {
      if (key === 'email_sessions:user@example.com') return Promise.resolve(JSON.stringify(['sid1', 'sid2']))
      if (key === 'session:sid1') return Promise.resolve(JSON.stringify({ access_token: 'at', expires_at: 0, client_id: 'client-a' }))
      if (key === 'session:sid2') return Promise.resolve(JSON.stringify({ refresh_token: 'rt2', access_token: 'at', expires_at: 0, client_id: 'client-a' }))
      return Promise.resolve(null)
    })
    const env = { SESSIONS: { get } }
    expect(await getRefreshTokenForEmail('user@example.com', 'client-a', env as any)).toBe('rt2')
  })

  it('returns null when all indexed sessions have no refresh_token', async () => {
    const get = vi.fn().mockImplementation((key: string) => {
      if (key === 'email_sessions:user@example.com') return Promise.resolve(JSON.stringify(['sid1']))
      if (key === 'session:sid1') return Promise.resolve(JSON.stringify({ access_token: 'at', expires_at: 0, client_id: 'client-a' }))
      return Promise.resolve(null)
    })
    const env = { SESSIONS: { get } }
    expect(await getRefreshTokenForEmail('user@example.com', 'client-a', env as any)).toBeNull()
  })

  it('skips a refresh_token minted by a different (e.g. retired Blue/Green) client', async () => {
    const get = vi.fn().mockImplementation((key: string) => {
      if (key === 'email_sessions:user@example.com') return Promise.resolve(JSON.stringify(['sid1', 'sid2']))
      if (key === 'session:sid1') return Promise.resolve(JSON.stringify({ refresh_token: 'rt-old', access_token: 'at', expires_at: 0, client_id: 'client-old' }))
      if (key === 'session:sid2') return Promise.resolve(JSON.stringify({ refresh_token: 'rt-current', access_token: 'at', expires_at: 0, client_id: 'client-a' }))
      return Promise.resolve(null)
    })
    const env = { SESSIONS: { get } }
    expect(await getRefreshTokenForEmail('user@example.com', 'client-a', env as any)).toBe('rt-current')
  })

  it('returns null when the only matching session predates client_id tracking', async () => {
    const get = vi.fn().mockImplementation((key: string) => {
      if (key === 'email_sessions:user@example.com') return Promise.resolve(JSON.stringify(['sid1']))
      if (key === 'session:sid1') return Promise.resolve(JSON.stringify({ refresh_token: 'rt1', access_token: 'at', expires_at: 0 }))
      return Promise.resolve(null)
    })
    const env = { SESSIONS: { get } }
    expect(await getRefreshTokenForEmail('user@example.com', 'client-a', env as any)).toBeNull()
  })

  it('normalizes email (uppercase) before looking up index', async () => {
    const get = vi.fn().mockResolvedValue(null)
    const env = { SESSIONS: { get } }
    await getRefreshTokenForEmail('User@Example.COM', 'client-a', env as any)
    expect(get).toHaveBeenCalledWith('email_sessions:user@example.com')
  })
})

describe('invalidateSession', () => {
  it('removes the session record and the email index entry', async () => {
    const get = vi.fn().mockResolvedValue(JSON.stringify(['sid1', 'sid2']))
    const put = vi.fn()
    const del = vi.fn()
    const env = { SESSIONS: { get, put, delete: del } }
    await invalidateSession('sid1', 'user@example.com', env as any)
    expect(put).toHaveBeenCalledWith('email_sessions:user@example.com', JSON.stringify(['sid2']), { expirationTtl: SESSION_TTL })
    expect(del).toHaveBeenCalledWith('session:sid1')
  })

  it('deletes the session record without touching the index when email is unknown', async () => {
    const get = vi.fn()
    const del = vi.fn()
    const env = { SESSIONS: { get, delete: del } }
    await invalidateSession('sid1', undefined, env as any)
    expect(get).not.toHaveBeenCalled()
    expect(del).toHaveBeenCalledWith('session:sid1')
  })
})

describe('removeEmailSessionIndex', () => {
  it('removes a session ID from the index', async () => {
    const get = vi.fn().mockResolvedValue(JSON.stringify(['sid1', 'sid2']))
    const put = vi.fn()
    const del = vi.fn()
    const env = { SESSIONS: { get, put, delete: del } }
    await removeEmailSessionIndex('user@example.com', 'sid1', env as any)
    expect(put).toHaveBeenCalledWith('email_sessions:user@example.com', JSON.stringify(['sid2']), { expirationTtl: SESSION_TTL })
    expect(del).not.toHaveBeenCalled()
  })

  it('deletes the index key when the last session is removed', async () => {
    const get = vi.fn().mockResolvedValue(JSON.stringify(['sid1']))
    const del = vi.fn()
    const env = { SESSIONS: { get, delete: del } }
    await removeEmailSessionIndex('user@example.com', 'sid1', env as any)
    expect(del).toHaveBeenCalledWith('email_sessions:user@example.com')
  })

  it('does nothing when no index exists', async () => {
    const get = vi.fn().mockResolvedValue(null)
    const put = vi.fn()
    const del = vi.fn()
    const env = { SESSIONS: { get, put, delete: del } }
    await removeEmailSessionIndex('user@example.com', 'sid1', env as any)
    expect(put).not.toHaveBeenCalled()
    expect(del).not.toHaveBeenCalled()
  })
})

describe('deleteAllSessionsForEmail', () => {
  it('deletes all sessions and removes the index key', async () => {
    const get = vi.fn().mockResolvedValue(JSON.stringify(['sid1', 'sid2']))
    const del = vi.fn().mockResolvedValue(undefined)
    const env = { SESSIONS: { get, delete: del } }
    await deleteAllSessionsForEmail('user@example.com', env as any)
    expect(del).toHaveBeenCalledWith('session:sid1')
    expect(del).toHaveBeenCalledWith('session:sid2')
    expect(del).toHaveBeenCalledWith('email_sessions:user@example.com')
  })

  it('normalizes email (uppercase) before looking up index', async () => {
    const get = vi.fn().mockResolvedValue(null)
    const env = { SESSIONS: { get, delete: vi.fn() } }
    await deleteAllSessionsForEmail('User@Example.COM', env as any)
    expect(get).toHaveBeenCalledWith('email_sessions:user@example.com')
  })

  it('keeps failed session IDs in the index when a delete fails', async () => {
    const get = vi.fn().mockResolvedValue(JSON.stringify(['sid1', 'sid2']))
    const del = vi.fn().mockImplementation((key: string) =>
      key === 'session:sid1' ? Promise.reject(new Error('KV error')) : Promise.resolve(undefined)
    )
    const put = vi.fn()
    const env = { SESSIONS: { get, delete: del, put } }
    await deleteAllSessionsForEmail('user@example.com', env as any)
    expect(put).toHaveBeenCalledWith(
      'email_sessions:user@example.com',
      JSON.stringify(['sid1']),
      expect.objectContaining({ expirationTtl: expect.any(Number) }),
    )
  })

  it('does nothing when no index exists', async () => {
    const get = vi.fn().mockResolvedValue(null)
    const del = vi.fn()
    const env = { SESSIONS: { get, delete: del } }
    await deleteAllSessionsForEmail('user@example.com', env as any)
    expect(del).not.toHaveBeenCalled()
  })
})
