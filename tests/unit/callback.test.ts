import { describe, expect, it, vi, afterEach } from 'vitest'
import { onRequestGet } from '../../functions/auth/callback'
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
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
    access_token: 'short-lived-access', expires_in: 3600, id_token: 'verified-id-token', ...overrides,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
}

describe('OAuth callback popup flow', () => {
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
