import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { onRequestGet, onRequestPost } from '../../functions/auth/login'

beforeEach(() => {
  vi.stubGlobal('crypto', {
    randomUUID: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    getRandomValues: (arr: Uint8Array) => { arr.set(Array.from({ length: arr.length }, (_, i) => i + 1)); return arr },
    subtle: { digest: async () => Uint8Array.from({ length: 32 }, (_, i) => i + 1).buffer },
  })
})
afterEach(() => vi.unstubAllGlobals())

function makeEnv(domain = 'https://example.com') {
  return {
    SESSIONS: { get: vi.fn(), delete: vi.fn(), put: vi.fn(), list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }) },
    GOOGLE_CLIENT_ID: 'test-client-id', GOOGLE_CLIENT_SECRET: 'test-client-secret', SESSION_DOMAIN: domain,
  }
}

describe('OAuth login popup redirect', () => {
  it('starts an online authorization code flow with least-privilege scope and PKCE', async () => {
    const env = makeEnv()
    const response = await onRequestGet({ env, request: new Request('https://example.com/auth/login') } as any)
    const url = new URL(response.headers.get('Location')!)
    expect(response.status).toBe(302)
    expect(url.origin).toBe('https://accounts.google.com')
    expect(url.pathname).toBe('/o/oauth2/v2/auth')
    expect(url.searchParams.get('client_id')).toBe('test-client-id')
    expect(url.searchParams.get('redirect_uri')).toBe('https://example.com/auth/callback')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('scope')?.split(' ').sort()).toEqual(['email', 'https://www.googleapis.com/auth/drive.file', 'openid'])
    expect(url.searchParams.get('include_granted_scopes')).toBe('false')
    expect(url.searchParams.get('access_type')).toBe('online')
    expect(url.searchParams.has('prompt')).toBe(false)
    expect(url.searchParams.get('nonce')).toBeTruthy()
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBeTruthy()
    expect(response.headers.get('Set-Cookie')).toContain('linger_oauth_state=')
    expect(response.headers.get('Set-Cookie')).toContain('SameSite=Lax')
  })

  it('forces account selection only when the caller explicitly requests it', async () => {
    const response = await onRequestGet({ env: makeEnv(), request: new Request('https://example.com/auth/login?select_account=1') } as any)
    expect(new URL(response.headers.get('Location')!).searchParams.get('prompt')).toBe('select_account')
  })

  it('keeps PKCE verifier in a short-lived HttpOnly cookie and stores only callback metadata', async () => {
    const env = makeEnv()
    const response = await onRequestGet({ env, request: new Request('https://example.com/auth/login') } as any)
    const url = new URL(response.headers.get('Location')!)
    const [key, value, options] = env.SESSIONS.put.mock.calls.find(call => String(call[0]).startsWith('oauth_state:'))!
    expect(key).toBe(`oauth_state:${url.searchParams.get('state')}`)
    expect(JSON.parse(value as string)).toMatchObject({ nonce: expect.any(String), popup: true })
    expect(JSON.parse(value as string)).not.toHaveProperty('codeVerifier')
    expect(response.headers.get('Set-Cookie')).toContain('linger_oauth_pkce=')
    expect(response.headers.get('Set-Cookie')).toContain('HttpOnly')
    expect(response.headers.get('Set-Cookie')).toContain('Path=/auth/callback')
    expect(options).toEqual({ expirationTtl: 300 })
    expect(value).not.toContain('access_token')
    expect(value).not.toContain('refresh_token')
  })

  it('does not scan or delete session keys while starting OAuth', async () => {
    const env = makeEnv()
    await onRequestGet({ env, request: new Request('https://example.com/auth/login') } as any)
    expect(env.SESSIONS.list).not.toHaveBeenCalled()
    expect(env.SESSIONS.delete).not.toHaveBeenCalled()
    expect(env.SESSIONS.put).toHaveBeenCalledWith(expect.stringMatching(/^oauth_state:/), expect.any(String), { expirationTtl: 300 })
  })

  it('rejects POST instead of accepting a credential-bearing login request', async () => {
    const response = await onRequestPost({} as any)
    expect(response.status).toBe(405)
  })
})
