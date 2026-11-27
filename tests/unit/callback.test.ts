import { describe, expect, it, vi, afterEach } from 'vitest'
import { onRequestGet } from '../../functions/auth/callback'
import { onRequestGet as startLogin } from '../../functions/auth/login'
import { onRequestPost as retireAccounts } from '../../functions/auth/passkey/recovery'
import { verifyGoogleIdToken } from '../../functions/_shared/google'
import { createPasskeyTestEnv } from '../helpers/passkeyAuth'
import { createPasskeySession, getPasskeySessionUserId, riscSubjectHash, sessionStorageId } from '../../functions/_shared/authStore'
import { sealVaultValue } from '../../functions/_shared/vaultCrypto'

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

const recoveryPepper = 'test-risc-pepper-value-at-least-32-chars'
const recoverySubject = 'google-sub-123'

async function recoveryFixture() {
  const fixture = await createPasskeyTestEnv({ google_sub: recoverySubject }, { riscPepper: recoveryPepper })
  const { db, env, userId, sessionId, key } = fixture
  const credentials = db.prepare(`INSERT INTO passkey_credentials
    (credential_id, user_id, public_key, prf_salt, wrapped_master_key, created_at)
    VALUES (?, ?, ?, 'salt', 'wrapped', ?)`)
  const now = Date.now()
  credentials.run('current-passkey', userId, new Uint8Array(1), now)
  db.prepare('UPDATE auth_sessions SET credential_id = ? WHERE id = ?').run('current-passkey', await sessionStorageId(sessionId))
  const addAccount = async (name: string, sub: string | null, createdAt: number) => {
    const hash = sub ? await riscSubjectHash(sub, recoveryPepper) : null
    db.prepare('INSERT INTO passkey_users (id, created_at, risc_subject_hash) VALUES (?, ?, ?)').run(name, createdAt, hash)
    credentials.run(`passkey-${name}`, name, new Uint8Array(1), createdAt)
    await createPasskeySession(`session-${name}`, name, env, `passkey-${name}`)
    const envelope = await sealVaultValue(key, name, 'google-refresh-token', { token: 'saved-refresh' })
    db.prepare('INSERT INTO google_refresh_vault (user_id, envelope, updated_at) VALUES (?, ?, ?)').run(name, envelope, now)
  }
  const saveCurrentGoogleConnection = async () => {
    const envelope = await sealVaultValue(key, userId, 'google-refresh-token', { token: 'new-refresh' })
    db.prepare('INSERT INTO google_refresh_vault (user_id, envelope, updated_at) VALUES (?, ?, ?)').run(userId, envelope, now)
  }
  const authorize = async () => {
    const first = await startLogin({ env, request: new Request('https://example.com/auth/login?retire_previous=1&reuse=1', {
      headers: { ...fixture.headers, 'Sec-Fetch-Site': 'same-origin' },
    }) } as never)
    expect(first.status).toBe(302)
    const state = new URL(first.headers.get('Location')!).searchParams.get('state')!
    const cookies = first.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ')
    const response = await onRequestGet({ env, request: new Request(`https://example.com/auth/callback?code=abc&state=${state}`, {
      headers: { Cookie: cookies },
    }) } as never)
    expect(response.status).toBe(200)
    const encoded = (await response.text()).match(/const encoded = '([^']+)'/)![1]
    return JSON.parse(Buffer.from(encoded, 'base64url').toString()) as unknown
  }
  const retire = (requestHeaders = fixture.headers) => retireAccounts({
    env, request: new Request('https://example.com/auth/passkey/recovery', {
      method: 'POST', headers: { ...requestHeaders, Origin: 'https://example.com' },
    }),
  } as never)
  return { ...fixture, now, addAccount, saveCurrentGoogleConnection, authorize, retire }
}

describe('lost-passkey recovery', () => {
  it('retains the current and newer accounts and revokes only matching older credentials after Google confirmation', async () => {
    mockTokenResponse({ refresh_token: 'provider-refresh' })
    const { db, env, userId, sessionId, now, addAccount, saveCurrentGoogleConnection, authorize, retire } = await recoveryFixture()
    try {
      await addAccount('old', recoverySubject, now - 1000)
      await addAccount('newer', recoverySubject, now + 1000)
      await addAccount('unrelated', 'another-subject', now - 1000)
      await addAccount('unindexed', null, now - 1000)
      expect((await retire()).status).toBe(409)
      expect(await authorize()).toEqual({ recovery: 'ready' })
      expect((await retire()).status).toBe(409)
      expect(await getPasskeySessionUserId('session-old', env)).toBe('old')

      await saveCurrentGoogleConnection()
      const results = await Promise.all([retire(), retire()])
      const applied = results.find(response => response.status === 200)
      expect(await applied?.json()).toEqual({ revokedPasskeys: 1 })
      expect(results.map(response => response.status).sort()).toEqual([200, 409])
      expect(await getPasskeySessionUserId('session-old', env)).toBeNull()
      expect(db.prepare('SELECT credential_id FROM passkey_credentials WHERE user_id = ?').get('old')).toBeUndefined()
      expect(db.prepare('SELECT envelope FROM google_refresh_vault WHERE user_id = ?').get('old')).toBeUndefined()
      expect(await getPasskeySessionUserId(sessionId, env)).toBe(userId)
      for (const name of ['newer', 'unrelated', 'unindexed']) {
        expect(await getPasskeySessionUserId(`session-${name}`, env)).toBe(name)
        expect(db.prepare('SELECT envelope FROM google_refresh_vault WHERE user_id = ?').get(name)).toBeTruthy()
      }
    } finally { db.close() }
  })

  it('requires the linked Google account and the current vault key', async () => {
    mockTokenResponse()
    const { db, headers, authorize, retire, saveCurrentGoogleConnection } = await recoveryFixture()
    try {
      await saveCurrentGoogleConnection()
      vi.mocked(verifyGoogleIdToken).mockResolvedValueOnce({ sub: 'wrong-account', iss: 'https://accounts.google.com', aud: 'client-id', exp: 1 })
      expect(await authorize()).toEqual({ recovery: 'account_mismatch' })
      expect((await retire()).status).toBe(409)
      expect(await authorize()).toEqual({ recovery: 'ready' })
      expect((await retire({ ...headers, 'X-Linger-Vault-Key': 'A'.repeat(43) })).status).toBe(401)
      db.prepare('UPDATE passkey_recovery_grants SET expires_at = 0').run()
      expect((await retire()).status).toBe(409)
    } finally { db.close() }
  })
})

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
