import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { onRequestGet } from '../../functions/auth/callback'
import { verifyGoogleIdToken } from '../../functions/_shared/google'
import { startSignIn } from '../../src/api/auth'
import { clearOAuthCredentials } from '../../src/lib/oauthCredentials'

vi.mock('../../functions/_shared/google', () => ({
  verifyGoogleIdToken: vi.fn().mockResolvedValue({ sub: 'google-sub-123', email: 'user@example.com', email_verified: true }),
}))

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
  vi.stubGlobal('crypto', { randomUUID: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', getRandomValues: (bytes: Uint8Array) => { bytes.fill(1); return bytes } })
})
afterEach(() => { clearOAuthCredentials(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks() })

function makeEnv(overrides: Record<string, any> = {}) {
  return {
    SESSIONS: { get: vi.fn().mockResolvedValue(JSON.stringify({ codeVerifier: 'verifier', nonce: 'nonce', popup: true })), delete: vi.fn(), put: vi.fn(), list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }) },
    GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: 'client-secret', SESSION_DOMAIN: 'https://example.com',
    ...overrides,
  }
}
function callbackRequest(params: Record<string, string>, cookieState = 'valid-state') {
  const url = new URL('https://example.com/auth/callback')
  url.search = new URLSearchParams(params).toString()
  return new Request(url, { headers: { Cookie: `linger_oauth_state=${encodeURIComponent(cookieState)}` } })
}
function mockTokenResponse(overrides: Record<string, unknown> = {}) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ access_token: 'short-lived-access', expires_in: 3600, id_token: 'verified-id-token', ...overrides }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
}

describe('OAuth callback popup flow', () => {
  it('completes sign-in when the popup message is delivered after a cancellation poll', async () => {
    mockTokenResponse()
    const response = await onRequestGet({ request: callbackRequest({ code: 'abc', state: 'valid-state' }), env: makeEnv({ SESSION_DOMAIN: window.location.origin }) } as any)
    const html = await response.text()
    const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)![1]

    const popup = { closed: false, close: vi.fn(function (this: { closed: boolean }) { this.closed = true }) }
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ signedIn: true, googleSub: 'google-sub-123' }))))
    const pending = startSignIn()
    const opener = { closed: false, postMessage: (data: unknown, origin: string) => {
      setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data, origin, source: popup as never })), 300)
    } }
    new Function('window', 'document', script)({ opener, close: popup.close.bind(popup) }, document)

    await vi.advanceTimersByTimeAsync(250)
    expect(popup.closed).toBe(false)
    await vi.advanceTimersByTimeAsync(50)
    await expect(pending).resolves.toMatchObject({ signedIn: true, googleSub: 'google-sub-123' })
    expect(popup.close).toHaveBeenCalledOnce()
  })

  it('rejects missing code or state', async () => {
    expect((await onRequestGet({ request: callbackRequest({ state: 'valid-state' }), env: makeEnv() } as any)).status).toBe(400)
    expect((await onRequestGet({ request: callbackRequest({ code: 'abc' }), env: makeEnv() } as any)).status).toBe(400)
  })

  it('rejects a callback opened in a different browser session before token exchange', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const get = vi.fn()
    const env = makeEnv({ SESSIONS: { get, delete: vi.fn(), put: vi.fn() } })
    const response = await onRequestGet({ request: callbackRequest({ code: 'abc', state: 'valid-state' }, 'different-state'), env } as any)
    expect(response.status).toBe(400)
    expect(get).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects absent or expired one-time OAuth state', async () => {
    const env = makeEnv({ SESSIONS: { get: vi.fn().mockResolvedValue(null), delete: vi.fn(), put: vi.fn() } })
    const response = await onRequestGet({ request: callbackRequest({ code: 'abc', state: 'valid-state' }), env } as any)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid or expired state' })
  })

  it('returns a popup page that sends credentials to the exact app origin and stores metadata only', async () => {
    mockTokenResponse()
    const put = vi.fn()
    const env = makeEnv({ SESSIONS: { get: makeEnv().SESSIONS.get, delete: vi.fn(), put, list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }) } })
    const response = await onRequestGet({ request: callbackRequest({ code: 'abc', state: 'valid-state' }), env } as any)

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain('text/html')
    expect(response.headers.get('Cache-Control')).toContain('no-store')
    expect(response.headers.get('Content-Security-Policy')).toContain('nonce-')
    expect(response.headers.get('Set-Cookie')).toContain('linger_session=')
    expect(response.headers.get('Set-Cookie')).toContain('linger_oauth_pkce=')
    expect(response.headers.get('Set-Cookie')).toContain('Path=/auth/callback')
    expect(response.headers.get('Set-Cookie')).toContain('HttpOnly')
    const html = await response.text()
    expect(html).toContain('window.opener.postMessage')
    expect(html).toContain("'https://example.com'")
    expect(html).toContain('linger-oauth-complete')
    // The opener closes the popup after receiving the message. Closing here can
    // race its cancellation poll before the queued message is delivered.
    expect(html).not.toContain('window.close()')
    const credentialJson = JSON.parse(atob(html.match(/const encoded = '([^']+)'/)![1].replace(/-/g, '+').replace(/_/g, '/')))
    expect(credentialJson).toMatchObject({ accessToken: 'short-lived-access', idToken: 'verified-id-token', expiresAt: expect.any(Number) })

    const sessionCall = put.mock.calls.find(call => String(call[0]).startsWith('session:'))!
    const savedSession = JSON.parse(sessionCall[1] as string)
    expect(savedSession).toMatchObject({ google_sub: 'google-sub-123', client_id: 'client-id' })
    expect(savedSession).not.toHaveProperty('email')
    expect(put.mock.calls.some(call => String(call[0]).startsWith('esidx:'))).toBe(false)
    expect(savedSession).not.toHaveProperty('access_token')
    expect(savedSession).not.toHaveProperty('id_token')
    expect(savedSession).not.toHaveProperty('refresh_token')
    expect(savedSession).not.toHaveProperty('expires_at')
    expect(verifyGoogleIdToken).toHaveBeenCalledWith('verified-id-token', 'client-id', 'nonce')
  })

  it('does not store credentials returned by Google, including legacy refresh tokens', async () => {
    mockTokenResponse({ refresh_token: 'must-not-persist' })
    const put = vi.fn()
    const env = makeEnv({ SESSIONS: { get: makeEnv().SESSIONS.get, delete: vi.fn(), put, list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }) } })
    await onRequestGet({ request: callbackRequest({ code: 'abc', state: 'valid-state' }), env } as any)
    const persisted = put.mock.calls.filter(call => String(call[0]).startsWith('session:')).map(call => String(call[1])).join('\n')
    expect(persisted).not.toContain('must-not-persist')
    expect(persisted).not.toContain('short-lived-access')
    expect(persisted).not.toContain('verified-id-token')
  })

  it('fails closed when Google returns no ID token or ID token verification fails', async () => {
    mockTokenResponse({ id_token: undefined })
    const env = makeEnv()
    expect((await onRequestGet({ request: callbackRequest({ code: 'abc', state: 'valid-state' }), env } as any)).status).toBe(500)
    vi.mocked(verifyGoogleIdToken).mockRejectedValueOnce(new Error('invalid signature'))
    mockTokenResponse()
    expect((await onRequestGet({ request: callbackRequest({ code: 'abc', state: 'valid-state' }), env } as any)).status).toBe(500)
  })

  it('does not expose upstream OAuth errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('secret internal error', { status: 400 })))
    const response = await onRequestGet({ request: callbackRequest({ code: 'abc', state: 'valid-state' }), env: makeEnv() } as any)
    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain('secret internal error')
    expect(response.headers.get('Set-Cookie')).toContain('linger_oauth_pkce=')
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0')
  })

  it('clears the PKCE cookie after a token endpoint network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('private network details')))
    const response = await onRequestGet({ request: callbackRequest({ code: 'abc', state: 'valid-state' }), env: makeEnv() } as any)
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Authentication failed. Please try again.' })
    expect(response.headers.get('Set-Cookie')).toContain('linger_oauth_pkce=')
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0')
  })

  it('clears the PKCE cookie when the token response is malformed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{', { status: 200 })))
    const response = await onRequestGet({ request: callbackRequest({ code: 'abc', state: 'valid-state' }), env: makeEnv() } as any)
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Authentication failed. Please try again.' })
    expect(response.headers.get('Set-Cookie')).toContain('linger_oauth_pkce=')
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0')
  })

  it.each([
    ['JSON null', 'null'],
    ['a JSON array', '[]'],
    ['a missing access token', JSON.stringify({ id_token: 'id', expires_in: 3600 })],
    ['an invalid expiration', JSON.stringify({ access_token: 'access', id_token: 'id', expires_in: '3600' })],
  ])('fails closed for token response shape: %s', async (_label, body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })))
    const response = await onRequestGet({ request: callbackRequest({ code: 'abc', state: 'valid-state' }), env: makeEnv() } as any)
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Authentication failed. Please try again.' })
    expect(response.headers.get('Set-Cookie')).toContain('linger_oauth_pkce=')
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0')
  })
})
