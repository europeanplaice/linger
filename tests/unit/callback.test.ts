import { describe, expect, it, vi, afterEach } from 'vitest'
import { onRequestGet } from '../../functions/auth/callback'
import { onRequestGet as startLogin } from '../../functions/auth/login'
import { verifyGoogleIdToken } from '../../functions/_shared/google'
import { createPasskeyTestEnv } from '../helpers/passkeyAuth'
import { sessionStorageId } from '../../functions/_shared/authStore'

vi.mock('../../functions/_shared/google', () => ({
  verifyGoogleIdToken: vi.fn().mockResolvedValue({ sub: 'google-sub-123', email: 'user@example.com', email_verified: true }),
}))

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks() })

async function makeEnv() {
  const fixture = await createPasskeyTestEnv({}, { domain: 'https://example.com' })
  await fixture.env.AUTH_DB!.prepare('INSERT INTO auth_oauth_states (id, data, expires_at) VALUES (?, ?, ?)')
    .bind('valid-state', JSON.stringify({
      nonce: 'nonce', popup: true, userId: fixture.userId,
      sessionHandle: await sessionStorageId(fixture.sessionId),
    }), Date.now() + 300_000).run()
  return fixture
}

function callbackRequest(params: Record<string, string>, cookieState = 'valid-state') {
  const url = new URL('https://example.com/auth/callback')
  url.search = new URLSearchParams(params).toString()
  return new Request(url, { headers: { Cookie: `linger_oauth_state=${encodeURIComponent(cookieState)}; linger_oauth_pkce=verifier` } })
}

function mockTokenResponse(overrides: Record<string, unknown> = {}) {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
    access_token: 'short-lived-access', expires_in: 3600, id_token: 'verified-id-token', ...overrides,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }))))
}

describe('OAuth callback popup flow', () => {
  it('completes concurrent browser attempts in reverse order with their own PKCE verifier', async () => {
    mockTokenResponse()
    const { env, db, sessionId } = await makeEnv()
    const request = new Request('https://example.com/auth/login', { headers: { Cookie: `linger_session=${sessionId}` } })
    const first = await startLogin({ request, env } as never)
    const second = await startLogin({ request, env } as never)
    const state1 = new URL(first.headers.get('Location')!).searchParams.get('state')!
    const state2 = new URL(second.headers.get('Location')!).searchParams.get('state')!
    expect(state1).not.toBe(state2)
    const cookies = [...first.headers.getSetCookie(), ...second.headers.getSetCookie()].map(cookie => cookie.split(';')[0]).join('; ')
    const callback = (state: string) => new Request(`https://example.com/auth/callback?code=abc&state=${state}`, { headers: { Cookie: cookies } })
    const verifier = (state: string) => cookies.match(new RegExp(`linger_oauth_pkce_${state}=([^;]+)`))![1]
    const result2 = await onRequestGet({ request: callback(state2), env } as never)
    expect(result2.status).toBe(200)
    expect(result2.headers.get('Set-Cookie')).toContain(`linger_oauth_pkce_${state2}=`)
    expect(result2.headers.get('Set-Cookie')).not.toContain(state1)
    const result1 = await onRequestGet({ request: callback(state1), env } as never)
    expect(result1.status).toBe(200)
    const calls = vi.mocked(fetch).mock.calls
    expect(new URLSearchParams(String(calls[0][1]?.body)).get('code_verifier')).toBe(verifier(state2))
    expect(new URLSearchParams(String(calls[1][1]?.body)).get('code_verifier')).toBe(verifier(state1))
    expect((await onRequestGet({ request: callback(state2), env } as never)).status).toBe(400)
    expect(fetch).toHaveBeenCalledTimes(2)
    db.close()
  })

  it('keeps another attempt usable when one callback fails', async () => {
    mockTokenResponse()
    const { env, db, sessionId } = await makeEnv()
    const request = new Request('https://example.com/auth/login', { headers: { Cookie: `linger_session=${sessionId}` } })
    const first = await startLogin({ request, env } as never)
    const second = await startLogin({ request, env } as never)
    const state1 = new URL(first.headers.get('Location')!).searchParams.get('state')!
    const state2 = new URL(second.headers.get('Location')!).searchParams.get('state')!
    const cookies = [...first.headers.getSetCookie(), ...second.headers.getSetCookie()].map(cookie => cookie.split(';')[0]).join('; ')
    const cancelled = await onRequestGet({ request: new Request(`https://example.com/auth/callback?error=access_denied&state=${state1}`, { headers: { Cookie: cookies } }), env } as never)
    expect(cancelled.status).toBe(400)
    const completed = await onRequestGet({ request: new Request(`https://example.com/auth/callback?code=abc&state=${state2}`, { headers: { Cookie: cookies } }), env } as never)
    expect(completed.status).toBe(200)
    db.close()
  })
  it('returns a verified email and refresh token during setup without persisting either', async () => {
    mockTokenResponse({ refresh_token: 'secret-refresh' })
    const { env, db } = await makeEnv()
    db.prepare('UPDATE auth_oauth_states SET data = ? WHERE id = ?').run(JSON.stringify({ nonce: 'nonce', popup: true, setup: true }), 'valid-state')
    const response = await onRequestGet({ request: callbackRequest({ code: 'abc', state: 'valid-state' }), env } as never)
    const html = await response.text()
    expect(response.status).toBe(200)
    const encoded = html.match(/const encoded = '([^']+)'/)![1]
    expect(JSON.parse(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')))).toMatchObject({ email: 'user@example.com', refreshToken: 'secret-refresh' })
    expect(db.prepare('SELECT COUNT(*) AS n FROM google_refresh_vault').get()).toEqual({ n: 0 })
    db.close()
  })
  it('returns verified Google credentials to the popup while leaving passkey session metadata opaque', async () => {
    mockTokenResponse()
    const { env, db, userId, sessionId } = await makeEnv()
    const response = await onRequestGet({ request: callbackRequest({ code: 'abc', state: 'valid-state' }), env } as never)
    const html = await response.text()
    expect(response.status).toBe(200)
    expect(html).toContain('window.opener.postMessage')
    expect(html).toContain("'https://example.com'")
    expect(html).toContain('linger-oauth-complete')
    expect(response.headers.get('Set-Cookie')).toContain('linger_oauth_pkce=')
    expect(response.headers.get('Set-Cookie')).not.toContain('linger_session=')
    const encoded = html.match(/const encoded = '([^']+)'/)![1]
    const credential = JSON.parse(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')))
    expect(credential).toMatchObject({ accessToken: 'short-lived-access', idToken: 'verified-id-token', expiresAt: expect.any(Number) })
    const row = db.prepare('SELECT user_id, data, revoked FROM auth_sessions WHERE id = ?').get(await sessionStorageId(sessionId))
    expect(row).toEqual({ user_id: userId, data: null, revoked: 0 })
    const profile = db.prepare('SELECT account_envelope FROM passkey_users WHERE id = ?').get(userId) as { account_envelope: string }
    expect(profile.account_envelope).toMatch(/^v1\./)
    expect(profile.account_envelope).not.toContain('google-sub-123')
    expect(verifyGoogleIdToken).toHaveBeenCalledWith('verified-id-token', 'client-id', 'nonce')
    db.close()
  })

  it('rejects missing code or state before exchanging a token', async () => {
    const { env, db } = await makeEnv()
    vi.stubGlobal('fetch', vi.fn())
    expect((await onRequestGet({ request: callbackRequest({ state: 'valid-state' }), env } as never)).status).toBe(400)
    expect((await onRequestGet({ request: callbackRequest({ code: 'abc' }), env } as never)).status).toBe(400)
    expect(fetch).not.toHaveBeenCalled()
    db.close()
  })

  it('rejects a callback opened in a different browser session before token exchange', async () => {
    const { env, db } = await makeEnv()
    vi.stubGlobal('fetch', vi.fn())
    const response = await onRequestGet({ request: callbackRequest({ code: 'abc', state: 'valid-state' }, 'different-state'), env } as never)
    expect(response.status).toBe(400)
    expect(fetch).not.toHaveBeenCalled()
    db.close()
  })

  it('rejects expired OAuth state and does not fall back to KV', async () => {
    const { env, db, kv } = await makeEnv()
    db.prepare('DELETE FROM auth_oauth_states WHERE id = ?').run('valid-state')
    const response = await onRequestGet({ request: callbackRequest({ code: 'abc', state: 'valid-state' }), env } as never)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid or expired state' })
    expect(kv.size()).toBe(0)
    db.close()
  })

  it('rejects a revoked passkey session before token exchange', async () => {
    const { env, db, sessionId } = await makeEnv()
    await env.AUTH_DB!.prepare('UPDATE auth_sessions SET revoked = 1 WHERE id = ?').bind(await sessionStorageId(sessionId)).run()
    vi.stubGlobal('fetch', vi.fn())
    const response = await onRequestGet({ request: callbackRequest({ code: 'abc', state: 'valid-state' }), env } as never)
    expect(response.status).toBe(401)
    expect(fetch).not.toHaveBeenCalled()
    db.close()
  })

  it('fails closed when Google token exchange or ID token verification fails', async () => {
    const first = await makeEnv()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('private network details')))
    const network = await onRequestGet({ request: callbackRequest({ code: 'abc', state: 'valid-state' }), env: first.env } as never)
    expect(network.status).toBe(500)
    expect(await network.text()).not.toContain('private network details')
    first.db.close()

    const second = await makeEnv()
    mockTokenResponse()
    vi.mocked(verifyGoogleIdToken).mockRejectedValueOnce(new Error('invalid signature'))
    const invalid = await onRequestGet({ request: callbackRequest({ code: 'abc', state: 'valid-state' }), env: second.env } as never)
    expect(invalid.status).toBe(500)
    expect(await invalid.text()).not.toContain('invalid signature')
    second.db.close()
  })

})
