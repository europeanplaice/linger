import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { onRequestGet } from '../../functions/auth/callback'

vi.mock('../../functions/_shared/google', () => ({
  verifyGoogleIdToken: vi.fn().mockResolvedValue({
    sub: 'google-sub-123',
    email: 'user@example.com',
    email_verified: true,
  }),
}))

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
  vi.stubGlobal('crypto', {
    randomUUID: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

interface Env {
  SESSIONS: { get: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn>; list?: ReturnType<typeof vi.fn> }
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  SESSION_DOMAIN: string
}

function makeEnv(overrides?: Partial<Env>): Env {
  return {
    SESSIONS: { get: vi.fn(), delete: vi.fn(), put: vi.fn(), list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }) },
    GOOGLE_CLIENT_ID: 'client-id',
    GOOGLE_CLIENT_SECRET: 'client-secret',
    SESSION_DOMAIN: 'https://example.com',
    ...overrides,
  }
}

function callbackUrl(params: Record<string, string>): string {
  const qs = new URLSearchParams(params).toString()
  return `http://localhost/auth/callback?${qs}`
}

function callbackRequest(params: Record<string, string>, cookieState = 'valid-state'): Request {
  return new Request(callbackUrl(params), {
    headers: { Cookie: `linger_oauth_state=${encodeURIComponent(cookieState)}` },
  })
}

describe('onRequestGet (OAuth callback)', () => {
  it('returns 400 when code is missing', async () => {
    const request = new Request(callbackUrl({ state: 'abc' }))
    const env = makeEnv()

    const response = await onRequestGet({ request, env } as any)

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body).toEqual({ error: 'Missing code or state' })
  })

  it('returns 400 when state is missing', async () => {
    const request = new Request(callbackUrl({ code: 'abc' }))
    const env = makeEnv()

    const response = await onRequestGet({ request, env } as any)

    expect(response.status).toBe(400)
  })

  it('returns 400 when state is invalid or expired', async () => {
    const env = makeEnv({ SESSIONS: { get: vi.fn().mockResolvedValue(null), delete: vi.fn(), put: vi.fn() } })
    const request = callbackRequest({ code: 'abc', state: 'invalid' }, 'invalid')

    const response = await onRequestGet({ request, env } as any)

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body).toEqual({ error: 'Invalid or expired state' })
  })

  it('rejects a callback opened in a different browser session', async () => {
    const get = vi.fn().mockResolvedValue('verifier')
    const env = makeEnv({ SESSIONS: { get, delete: vi.fn(), put: vi.fn() } })
    const request = callbackRequest({ code: 'abc', state: 'valid-state' }, 'different-state')

    const response = await onRequestGet({ request, env } as any)

    expect(response.status).toBe(400)
    expect(get).not.toHaveBeenCalled()
  })

  it('returns 500 when token exchange fails without exposing upstream error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('secret internal error from Google', { status: 400 })))
    const env = makeEnv({ SESSIONS: { get: vi.fn().mockResolvedValue('verifier'), delete: vi.fn(), put: vi.fn(), list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }) } })
    const request = callbackRequest({ code: 'abc', state: 'valid-state' })

    const response = await onRequestGet({ request, env } as any)

    expect(response.status).toBe(500)
    const body = await response.json() as Record<string, unknown>
    expect(body.error).not.toContain('secret internal error from Google')
    expect(typeof body.error).toBe('string')
  })

  it('redirects with auth_error=no_refresh_token when no refresh_token is received', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'at', expires_in: 3600, id_token: 'verified-id-token' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ))
    const env = makeEnv({ SESSIONS: { get: vi.fn().mockResolvedValue('verifier'), delete: vi.fn(), put: vi.fn(), list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }) } })
    const request = callbackRequest({ code: 'abc', state: 'valid-state' })

    const response = await onRequestGet({ request, env } as any)

    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('/?auth_error=no_refresh_token')
  })

  it('reuses stored refresh_token when Google omits it on repeat sign-in, from a session matching the live client', async () => {
    const idToken = `header.${btoa(JSON.stringify({ email: 'user@example.com' }))}.sig`
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'at', expires_in: 3600, id_token: idToken }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ))
    const put = vi.fn()
    const list = vi.fn().mockResolvedValue({ keys: [{ name: 'esidx:user@example.com:old-session' }], list_complete: true })
    const get = vi.fn().mockImplementation((key: string) => {
      if (key === 'session:old-session') return Promise.resolve(JSON.stringify({ refresh_token: 'stored-rt', access_token: 'old-at', expires_at: 0, client_id: 'client-id' }))
      return Promise.resolve('verifier')
    })
    const env = makeEnv({ SESSIONS: { get, list, delete: vi.fn(), put } })
    const request = callbackRequest({ code: 'abc', state: 'valid-state' })

    const response = await onRequestGet({ request, env } as any)

    expect(response.status).toBe(302)
    const sessionCall = put.mock.calls.find(call => (call[0] as string).startsWith('session:'))
    const savedSession = JSON.parse(sessionCall![1] as string)
    expect(savedSession.refresh_token).toBe('stored-rt')
    expect(savedSession.client_id).toBe('client-id')
  })

  it('does not reuse a stored refresh_token minted by a different (e.g. retired Blue/Green) OAuth client', async () => {
    const idToken = `header.${btoa(JSON.stringify({ email: 'user@example.com' }))}.sig`
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'at', expires_in: 3600, id_token: idToken }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ))
    const list = vi.fn().mockResolvedValue({ keys: [{ name: 'esidx:user@example.com:old-session' }], list_complete: true })
    const get = vi.fn().mockImplementation((key: string) => {
      if (key === 'session:old-session') return Promise.resolve(JSON.stringify({ refresh_token: 'stored-rt', access_token: 'old-at', expires_at: 0, client_id: 'retired-client' }))
      return Promise.resolve('verifier')
    })
    const env = makeEnv({ SESSIONS: { get, list, delete: vi.fn(), put: vi.fn() } })
    const request = callbackRequest({ code: 'abc', state: 'valid-state' })

    const response = await onRequestGet({ request, env } as any)

    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('/?auth_error=no_refresh_token')
  })

  it('returns 302 on success with session cookie', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, id_token: 'verified-id-token' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ))
    const put = vi.fn()
    const env = makeEnv({ SESSIONS: { get: vi.fn().mockResolvedValue('verifier'), delete: vi.fn(), put } })
    const request = callbackRequest({ code: 'abc', state: 'valid-state' })

    const response = await onRequestGet({ request, env } as any)

    expect(response.status).toBe(302)
    const setCookie = response.headers.get('Set-Cookie')
    expect(setCookie).toContain('linger_session=')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('Secure')
    expect(setCookie).toContain('Max-Age=')
    expect(response.headers.get('Location')).toBe('/')
    const sessionCall = put.mock.calls.find(call => (call[0] as string).startsWith('session:'))
    const savedSession = JSON.parse(sessionCall![1] as string)
    expect(savedSession.client_id).toBe('client-id')
  })

  it('saves email from id_token into session', async () => {
    const idTokenPayload = btoa(JSON.stringify({ email: 'user@example.com' }))
    const idToken = `header.${idTokenPayload}.sig`
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, id_token: idToken }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ))
    const put = vi.fn()
    const get = vi.fn().mockResolvedValue('verifier')
    const env = makeEnv({ SESSIONS: { get, delete: vi.fn(), put } })
    const request = callbackRequest({ code: 'abc', state: 'valid-state' })

    await onRequestGet({ request, env } as any)

    const sessionCall = put.mock.calls.find(call => (call[0] as string).startsWith('session:'))
    const savedSession = JSON.parse(sessionCall![1] as string)
    expect(savedSession.email).toBe('user@example.com')
  })

  it('rejects a token response without an ID token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ))
    const put = vi.fn()
    const env = makeEnv({ SESSIONS: { get: vi.fn().mockResolvedValue('verifier'), delete: vi.fn(), put } })
    const request = callbackRequest({ code: 'abc', state: 'valid-state' })

    const response = await onRequestGet({ request, env } as any)
    expect(response.status).toBe(500)
    expect(put).not.toHaveBeenCalled()
  })

  it('redirects to / when returnPath is protocol-relative (//evil.com)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, id_token: 'verified-id-token' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ))
    const env = makeEnv({ SESSIONS: { get: vi.fn().mockResolvedValue('verifier'), delete: vi.fn(), put: vi.fn() } })
    const request = callbackRequest({ code: 'abc', state: 'valid-state' })

    const response = await onRequestGet({ request, env } as any)

    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('/')
  })

  it('redirects to the return path from state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, id_token: 'verified-id-token' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ))
    const env = makeEnv({ SESSIONS: { get: vi.fn().mockResolvedValue(JSON.stringify({ codeVerifier: 'verifier', returnPath: '/some/path' })), delete: vi.fn(), put: vi.fn(), list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }) } })
    const request = callbackRequest({ code: 'abc', state: 'valid-state' })

    const response = await onRequestGet({ request, env } as any)

    expect(response.headers.get('Location')).toBe('/some/path')
  })
})
