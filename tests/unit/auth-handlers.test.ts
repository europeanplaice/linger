import { describe, expect, it, vi, afterEach } from 'vitest'
import { onRequestPost as onLogout } from '../../functions/auth/logout'
import { onRequestGet as onSessionCheck } from '../../functions/auth/session'
import { sessionStorageId } from '../../functions/_shared/authStore'
import { createPasskeyTestEnv } from '../helpers/passkeyAuth'
import { GoogleAccessTokenValidationError, GoogleIdTokenValidationError } from '../../functions/_shared/google'

const { mockVerifyAccess, mockVerifyId } = vi.hoisted(() => ({
  mockVerifyAccess: vi.fn().mockResolvedValue(3600),
  mockVerifyId: vi.fn().mockResolvedValue({ sub: 'google-sub-123', email: 'user@example.com' }),
}))
vi.mock('../../functions/_shared/google', () => ({
  verifyGoogleAccessToken: mockVerifyAccess,
  verifyGoogleIdToken: mockVerifyId,
  GoogleAccessTokenValidationError: class GoogleAccessTokenValidationError extends Error { constructor(message: string, readonly transient: boolean) { super(message) } },
  GoogleIdTokenValidationError: class GoogleIdTokenValidationError extends Error { constructor(message: string, readonly transient: boolean) { super(message) } },
}))

afterEach(() => {
  vi.unstubAllGlobals()
  mockVerifyAccess.mockReset().mockResolvedValue(3600)
  mockVerifyId.mockReset().mockResolvedValue({ sub: 'google-sub-123', email: 'user@example.com' })
})

describe('logout handler', () => {
  it('revokes only the passkey session and clears the cookie', async () => {
    const { env, db, headers, sessionId, userId } = await createPasskeyTestEnv({ google_sub: 'google-sub-123' })
    const request = new Request('https://example.com/auth/logout', {
      method: 'POST', headers: { ...headers, 'X-Linger-Account': 'sub:google-sub-123' },
    })
    const response = await onLogout({ request, env } as never)
    expect(response.status).toBe(200)
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0')
    expect(db.prepare('SELECT user_id, data, revoked FROM auth_sessions WHERE id = ?').get(await sessionStorageId(sessionId)))
      .toEqual({ user_id: null, data: null, revoked: 1 })
    expect(db.prepare('SELECT id FROM passkey_users WHERE id = ?').get(userId)).toEqual({ id: userId })
    db.close()
  })

  it('does not revoke a session if the browser vault user changed', async () => {
    const { env, db, headers, sessionId, userId } = await createPasskeyTestEnv()
    const request = new Request('https://example.com/auth/logout', {
      method: 'POST', headers: { ...headers, 'X-Linger-Vault-User': 'another-user' },
    })
    expect((await onLogout({ request, env } as never)).status).toBe(401)
    expect(db.prepare('SELECT user_id, revoked FROM auth_sessions WHERE id = ?').get(await sessionStorageId(sessionId)))
      .toEqual({ user_id: userId, revoked: 0 })
    db.close()
  })

  it('rejects cross-site logout requests before revocation', async () => {
    const { env, db, headers, sessionId, userId } = await createPasskeyTestEnv()
    const request = new Request('https://example.com/auth/logout', {
      method: 'POST', headers: { ...headers, Origin: 'https://attacker.example', 'Sec-Fetch-Site': 'cross-site' },
    })
    expect((await onLogout({ request, env } as never)).status).toBe(403)
    expect(db.prepare('SELECT user_id, revoked FROM auth_sessions WHERE id = ?').get(await sessionStorageId(sessionId)))
      .toEqual({ user_id: userId, revoked: 0 })
    db.close()
  })

  it('omits Secure flag on HTTP domains', async () => {
    const { env, db, headers } = await createPasskeyTestEnv({}, { domain: 'http://localhost:8788' })
    const response = await onLogout({ request: new Request('http://localhost:8788/auth/logout', { method: 'POST', headers }), env } as never)
    expect(response.headers.get('Set-Cookie')).not.toContain('Secure')
    db.close()
  })
})

describe('session check handler', () => {
  it.each([
    ['ID token', mockVerifyId, GoogleIdTokenValidationError],
    ['access token', mockVerifyAccess, GoogleAccessTokenValidationError],
  ] as const)('preserves the session and retries after a temporary %s validation failure', async (_label, verify, ValidationError) => {
    const { env, db, headers, sessionId } = await createPasskeyTestEnv({ google_sub: 'google-sub-123' })
    try {
      const storedSession = db.prepare('SELECT * FROM auth_sessions WHERE id = ?').get(await sessionStorageId(sessionId))
      const storedProfile = db.prepare('SELECT * FROM passkey_users').all()
      verify.mockRejectedValueOnce(new ValidationError('private upstream details', true))
      const invoke = () => onSessionCheck({ env, request: new Request('https://example.com/auth/session', {
        headers: { ...headers, Authorization: 'Bearer request-access', 'X-Linger-Google-ID-Token': 'request-id-token' },
      }) } as never)
      const unavailable = await invoke()
      expect(unavailable.status).toBe(503)
      expect(unavailable.headers.get('Retry-After')).toBe('1')
      expect(unavailable.headers.get('Cache-Control')).toBe('no-store')
      expect(unavailable.headers.get('Set-Cookie')).toBeNull()
      const body = await unavailable.json()
      expect(body).not.toHaveProperty('signedIn')
      expect(JSON.stringify(body)).not.toContain('private upstream details')
      expect(db.prepare('SELECT * FROM auth_sessions WHERE id = ?').get(await sessionStorageId(sessionId))).toEqual(storedSession)
      expect(db.prepare('SELECT * FROM passkey_users').all()).toEqual(storedProfile)
      const recovered = await invoke()
      expect(recovered.status).toBe(200)
      expect(await recovered.json()).toMatchObject({ signedIn: true, googleSub: 'google-sub-123' })
    } finally { db.close() }
  })

  it.each([
    ['ID token', mockVerifyId, GoogleIdTokenValidationError],
    ['access token', mockVerifyAccess, GoogleAccessTokenValidationError],
  ] as const)('reports signed out for a rejected %s instead of a temporary outage', async (_label, verify, ValidationError) => {
    const { env, db, headers } = await createPasskeyTestEnv({ google_sub: 'google-sub-123' })
    try {
      const storedProfile = db.prepare('SELECT * FROM passkey_users').all()
      verify.mockRejectedValueOnce(new ValidationError('invalid token', false))
      const response = await onSessionCheck({ env, request: new Request('https://example.com/auth/session', {
        headers: { ...headers, Authorization: 'Bearer request-access', 'X-Linger-Google-ID-Token': 'request-id-token' },
      }) } as never)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ signedIn: false })
      expect(response.headers.get('Retry-After')).toBeNull()
      expect(response.headers.get('Set-Cookie')).toBeNull()
      expect(db.prepare('SELECT * FROM passkey_users').all()).toEqual(storedProfile)
    } finally { db.close() }
  })

  it('verifies request-scoped Google credentials and seals account metadata', async () => {
    const { env, db, headers, sessionId, userId, key } = await createPasskeyTestEnv()
    const request = new Request('https://example.com/auth/session', {
      headers: { ...headers, Authorization: 'Bearer request-access', 'X-Linger-Google-ID-Token': 'request-id-token' },
    })
    const response = await onSessionCheck({ request, env } as never)
    const data = await response.json()
    expect(data).toMatchObject({ signedIn: true, userId, email: 'user@example.com', googleSub: 'google-sub-123' })
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=2592000')
    expect(mockVerifyAccess).toHaveBeenCalledWith('request-access', 'client-id', 'google-sub-123')
    expect(mockVerifyId).toHaveBeenCalledWith('request-id-token', 'client-id')
    const storedSession = db.prepare('SELECT data FROM auth_sessions WHERE id = ?').get(await sessionStorageId(sessionId)) as { data: null }
    expect(storedSession.data).toBeNull()
    const envelope = db.prepare('SELECT account_envelope FROM passkey_users WHERE id = ?').get(userId) as { account_envelope: string }
    expect(envelope.account_envelope).toMatch(/^v1\./)
    expect(envelope.account_envelope).not.toContain(key)
    expect(envelope.account_envelope).not.toContain('google-sub-123')
    expect(envelope.account_envelope).not.toContain('request-access')
    expect(envelope.account_envelope).not.toContain('request-id-token')
    db.close()
  })

  it('returns signed out without both request-scoped Google tokens', async () => {
    const { env, db, headers } = await createPasskeyTestEnv()
    const missingAccess = new Request('https://example.com/auth/session', { headers: { ...headers, 'X-Linger-Google-ID-Token': 'id' } })
    const missingId = new Request('https://example.com/auth/session', { headers: { ...headers, Authorization: 'Bearer access' } })
    expect(await (await onSessionCheck({ request: missingAccess, env } as never)).json()).toEqual({ signedIn: false })
    expect(await (await onSessionCheck({ request: missingId, env } as never)).json()).toEqual({ signedIn: false })
    expect(mockVerifyAccess).not.toHaveBeenCalled()
    expect(mockVerifyId).not.toHaveBeenCalled()
    db.close()
  })

  it('rejects a Google identity from another linked account and unauthenticated cookies', async () => {
    const { env, db, headers } = await createPasskeyTestEnv({ google_sub: 'google-sub-123' })
    mockVerifyId.mockResolvedValueOnce({ sub: 'different-account' })
    const request = new Request('https://example.com/auth/session', {
      headers: { ...headers, Authorization: 'Bearer request-access', 'X-Linger-Google-ID-Token': 'other-id-token' },
    })
    expect(await (await onSessionCheck({ request, env } as never)).json()).toEqual({ signedIn: false })
    const noCookie = new Request('https://example.com/auth/session', { headers: { Authorization: 'Bearer request-access', 'X-Linger-Google-ID-Token': 'id' } })
    expect(await (await onSessionCheck({ request: noCookie, env } as never)).json()).toEqual({ signedIn: false })
    db.close()
  })
})
