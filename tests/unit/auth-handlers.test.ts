import { describe, expect, it, vi, afterEach } from 'vitest'
import { onRequestPost as onLogout } from '../../functions/auth/logout'
import { onRequestGet as onSessionCheck } from '../../functions/auth/session'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('logout handler', () => {
  it('deletes session and clears cookie', async () => {
    const del = vi.fn()
    const get = vi.fn().mockResolvedValue(null)
    const request = new Request('http://localhost/auth/logout', {
      headers: { Cookie: 'linger_session=sid123' },
    })
    const env = { SESSIONS: { get, delete: del }, SESSION_DOMAIN: 'https://example.com' }

    const response = await onLogout({ request, env } as any)

    expect(response.status).toBe(200)
    expect(del).toHaveBeenCalledWith('session:sid123')
    const cookie = response.headers.get('Set-Cookie')
    expect(cookie).toContain('Max-Age=0')
  })

  it('removes email index entry on logout', async () => {
    const session = { refresh_token: 'rt', access_token: 'at', expires_at: 9999999999999, email: 'user@example.com' }
    const get = vi.fn().mockImplementation((key: string) => {
      if (key === 'session:sid123') return Promise.resolve(JSON.stringify(session))
      if (key === 'email_sessions:user@example.com') return Promise.resolve(JSON.stringify(['sid123', 'sid456']))
      return Promise.resolve(null)
    })
    const del = vi.fn()
    const put = vi.fn()
    const request = new Request('http://localhost/auth/logout', {
      headers: { Cookie: 'linger_session=sid123' },
    })
    const env = { SESSIONS: { get, delete: del, put }, SESSION_DOMAIN: 'https://example.com' }

    await onLogout({ request, env } as any)

    expect(put).toHaveBeenCalledWith(
      'email_sessions:user@example.com',
      JSON.stringify(['sid456']),
      expect.objectContaining({ expirationTtl: expect.any(Number) }),
    )
    expect(del).toHaveBeenCalledWith('session:sid123')
  })

  it('works without a session cookie', async () => {
    const del = vi.fn()
    const request = new Request('http://localhost/auth/logout')
    const env = { SESSIONS: { delete: del }, SESSION_DOMAIN: 'https://example.com' }

    const response = await onLogout({ request, env } as any)

    expect(response.status).toBe(200)
    expect(del).not.toHaveBeenCalled()
  })

  it('rejects cross-site logout requests', async () => {
    const del = vi.fn()
    const request = new Request('http://localhost/auth/logout', {
      method: 'POST',
      headers: {
        Cookie: 'linger_session=sid123',
        Origin: 'https://attacker.example',
        'Sec-Fetch-Site': 'cross-site',
      },
    })
    const env = { SESSIONS: { delete: del }, SESSION_DOMAIN: 'https://example.com' }

    const response = await onLogout({ request, env } as any)

    expect(response.status).toBe(403)
    expect(del).not.toHaveBeenCalled()
  })

  it('omits Secure flag on HTTP domains', async () => {
    const get = vi.fn().mockResolvedValue(null)
    const request = new Request('http://localhost/auth/logout', {
      headers: { Cookie: 'linger_session=sid' },
    })
    const env = { SESSIONS: { get, delete: vi.fn() }, SESSION_DOMAIN: 'http://localhost:8788' }

    const response = await onLogout({ request, env } as any)

    const cookie = response.headers.get('Set-Cookie')
    expect(cookie).not.toContain('Secure')
  })
})

describe('session check handler', () => {
  it('returns signedIn: true when session exists', async () => {
    const put = vi.fn()
    const request = new Request('http://localhost/auth/session', {
      headers: { Cookie: 'linger_session=sid123' },
    })
    const env = {
      SESSIONS: { get: vi.fn().mockResolvedValue(JSON.stringify({})), put },
      SESSION_DOMAIN: 'https://example.com',
    }

    const response = await onSessionCheck({ request, env } as any)
    const data = await response.json()

    expect(data).toMatchObject({ signedIn: true })
    expect(put).not.toHaveBeenCalled()
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=2592000')
  })

  it('returns signedIn: false when no cookie', async () => {
    const request = new Request('http://localhost/auth/session')
    const env = { SESSIONS: { get: vi.fn() } }

    const response = await onSessionCheck({ request, env } as any)
    const data = await response.json()

    expect(data).toEqual({ signedIn: false })
  })

  it('returns signedIn: false when session not in KV', async () => {
    const request = new Request('http://localhost/auth/session', {
      headers: { Cookie: 'linger_session=sid123' },
    })
    const env = { SESSIONS: { get: vi.fn().mockResolvedValue(null) } }

    const response = await onSessionCheck({ request, env } as any)
    const data = await response.json()

    expect(data).toEqual({ signedIn: false })
  })
})
