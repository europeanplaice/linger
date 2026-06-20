import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { onRequest } from '../../functions/api/_middleware'

function makeSession(overrides?: Record<string, unknown>) {
  return {
    refresh_token: 'rt',
    access_token: 'at',
    expires_at: Date.now() + 3600_000,
    ...overrides,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('API auth middleware', () => {
  function makeContext(overrides?: Record<string, unknown>) {
    const baseEnv = {
      SESSIONS: { get: vi.fn(), put: vi.fn(), delete: vi.fn() },
      GOOGLE_CLIENT_ID: 'id',
      GOOGLE_CLIENT_SECRET: 'secret',
      SESSION_DOMAIN: 'https://example.com',
    }
    const envOverride = overrides?.env as Record<string, unknown> | undefined
    return {
      request: new Request('http://localhost/api/drive/entries'),
      data: {} as Record<string, unknown>,
      next: vi.fn().mockReturnValue(new Response('ok')),
      ...overrides,
      env: { ...baseEnv, ...envOverride },
    }
  }

  it('returns 401 when no session cookie', async () => {
    const ctx = makeContext()

    const response = await onRequest(ctx as any)

    expect(response.status).toBe(401)
    expect(ctx.next).not.toHaveBeenCalled()
  })

  it('rejects cross-site mutation requests before resolving the session', async () => {
    const ctx = makeContext({
      request: new Request('http://localhost/api/drive/entry/2026-05-01', {
        method: 'POST',
        headers: {
          Cookie: 'linger_session=sid123',
          Origin: 'https://attacker.example',
          'Sec-Fetch-Site': 'cross-site',
        },
      }),
    })

    const response = await onRequest(ctx as any)

    expect(response.status).toBe(403)
    expect(ctx.next).not.toHaveBeenCalled()
    expect(ctx.env.SESSIONS.get).not.toHaveBeenCalled()
  })

  it('returns 401 when session not in KV', async () => {
    const ctx = makeContext({
      request: new Request('http://localhost/api/drive/entries', {
        headers: { Cookie: 'linger_session=sid123' },
      }),
      env: { SESSIONS: { get: vi.fn().mockResolvedValue(null) } },
    })

    const response = await onRequest(ctx as any)

    expect(response.status).toBe(401)
    expect(ctx.next).not.toHaveBeenCalled()
  })

  it('returns 401 when token refresh fails', async () => {
    const expiredSession = makeSession({ expires_at: Date.now() - 60_000 })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Unauthorized', { status: 401 })))
    const ctx = makeContext({
      request: new Request('http://localhost/api/drive/entries', {
        headers: { Cookie: 'linger_session=sid123' },
      }),
      env: { SESSIONS: { get: vi.fn().mockResolvedValue(JSON.stringify(expiredSession)), put: vi.fn() } },
    })

    const response = await onRequest(ctx as any)

    expect(response.status).toBe(401)
    expect(ctx.next).not.toHaveBeenCalled()
  })

  it('calls next() with sessionId and accessToken in data', async () => {
    const session = makeSession()
    const put = vi.fn()
    const ctx = makeContext({
      request: new Request('http://localhost/api/drive/entries', {
        headers: { Cookie: 'linger_session=sid123' },
      }),
      env: { SESSIONS: { get: vi.fn().mockResolvedValue(JSON.stringify(session)), put } },
    })

    const response = await onRequest(ctx as any)

    expect(response.status).toBe(200)
    expect(ctx.data.sessionId).toBe('sid123')
    expect(ctx.data.accessToken).toBe('at')
    expect(ctx.next).toHaveBeenCalledOnce()
    // renewed_at is added on first write (no prior renewed_at)
    expect(put).toHaveBeenCalledWith(
      'session:sid123',
      JSON.stringify({ ...session, renewed_at: Date.now() }),
      { expirationTtl: 60 * 60 * 24 * 30 },
    )
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=2592000')
  })

  it('skips KV write when renewed_at is recent', async () => {
    const session = makeSession({ renewed_at: Date.now() - 60_000 }) // renewed 1 minute ago
    const put = vi.fn()
    const ctx = makeContext({
      request: new Request('http://localhost/api/drive/entries', {
        headers: { Cookie: 'linger_session=sid123' },
      }),
      env: { SESSIONS: { get: vi.fn().mockResolvedValue(JSON.stringify(session)), put } },
    })

    await onRequest(ctx as any)

    expect(put).not.toHaveBeenCalled()
  })

  it('writes to KV when renewed_at is older than 24 hours', async () => {
    const session = makeSession({ renewed_at: Date.now() - 25 * 60 * 60 * 1000 })
    const put = vi.fn()
    const ctx = makeContext({
      request: new Request('http://localhost/api/drive/entries', {
        headers: { Cookie: 'linger_session=sid123' },
      }),
      env: { SESSIONS: { get: vi.fn().mockResolvedValue(JSON.stringify(session)), put } },
    })

    await onRequest(ctx as any)

    expect(put).toHaveBeenCalledOnce()
  })

  it('sets X-Deploy-Version header when CF_PAGES_COMMIT_SHA is present in env', async () => {
    const session = makeSession()
    const ctx = makeContext({
      request: new Request('http://localhost/api/drive/entries', {
        headers: { Cookie: 'linger_session=sid123' },
      }),
      env: {
        SESSIONS: { get: vi.fn().mockResolvedValue(JSON.stringify(session)), put: vi.fn() },
        CF_PAGES_COMMIT_SHA: 'abc1234',
      },
    })

    const response = await onRequest(ctx as any)

    expect(response.headers.get('X-Deploy-Version')).toBe('abc1234')
  })

  it('omits X-Deploy-Version header when CF_PAGES_COMMIT_SHA is absent', async () => {
    const session = makeSession()
    const ctx = makeContext({
      request: new Request('http://localhost/api/drive/entries', {
        headers: { Cookie: 'linger_session=sid123' },
      }),
      env: { SESSIONS: { get: vi.fn().mockResolvedValue(JSON.stringify(session)), put: vi.fn() } },
    })

    const response = await onRequest(ctx as any)

    expect(response.headers.get('X-Deploy-Version')).toBeNull()
  })
})
