import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPasskeyTestEnv } from '../helpers/passkeyAuth'
import { deferred } from '../helpers/deferred'

const webauthn = vi.hoisted(() => ({
  generateAuthenticationOptions: vi.fn(),
  generateRegistrationOptions: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
  verifyRegistrationResponse: vi.fn(),
}))

vi.mock('@simplewebauthn/server', () => webauthn)

import { addOptions, addVerify, deleteCredential, listCredentials, loginOptions, loginVerify, registrationOptions, registrationVerify } from '../../functions/_shared/passkeys'
import { createPasskeySession, sessionStorageId } from '../../functions/_shared/authStore'

const origin = 'https://example.com'
const challenge = 'test-challenge-value'
const credentialId = 'credential-id-for-test'
const wrappedMasterKey = btoa(String.fromCharCode(...new Uint8Array(60)))
const prfSalt = btoa(String.fromCharCode(...new Uint8Array(32)))
const registrationResponse = {
  id: credentialId,
  rawId: credentialId,
  type: 'public-key',
  response: { attestationObject: 'attestation', clientDataJSON: 'client-data', transports: ['internal'] },
  clientExtensionResults: { prf: { enabled: true } },
}
const assertionResponse = {
  id: credentialId,
  rawId: credentialId,
  type: 'public-key',
  response: { authenticatorData: 'auth-data', clientDataJSON: 'client-data', signature: 'signature' },
  clientExtensionResults: { prf: { enabled: true } },
}

function base64url(value: string): string {
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function request(path: string, body?: unknown, headers: HeadersInit = {}): Request {
  return new Request(`${origin}${path}`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function challengeCookie(response: Response): string {
  const cookie = response.headers.get('set-cookie') ?? ''
  return cookie.split(';', 1)[0]
}

async function grant(db: Awaited<ReturnType<typeof createPasskeyTestEnv>>['db'], sessionId: string, action: 'add' | 'delete') {
  db.prepare('INSERT OR REPLACE INTO passkey_management_grants (session_id, action, expires_at) VALUES (?, ?, ?)')
    .run(await sessionStorageId(sessionId), action, Date.now() + 60_000)
}

function seedCredential(db: Awaited<ReturnType<typeof createPasskeyTestEnv>>['db'], userId: string, counter = 1, id = credentialId) {
  db.prepare(`INSERT INTO passkey_credentials (credential_id, user_id, public_key, counter, transports, prf_salt, wrapped_master_key, created_at)
    VALUES (?, ?, ?, ?, '[]', ?, ?, ?)`)
    .run(id, userId, new Uint8Array([1, 2, 3]), counter, prfSalt, wrappedMasterKey, Date.now())
}

afterEach(() => { vi.useRealTimers() })

describe('passkey handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    webauthn.generateRegistrationOptions.mockResolvedValue({ challenge, rp: { id: 'example.com' } })
    webauthn.generateAuthenticationOptions.mockResolvedValue({ challenge, allowCredentials: [] })
    webauthn.verifyRegistrationResponse.mockResolvedValue({
      verified: true,
      registrationInfo: { credential: { id: credentialId, publicKey: new Uint8Array([1, 2, 3]), counter: 0 } },
    })
    webauthn.verifyAuthenticationResponse.mockResolvedValue({ verified: true, authenticationInfo: { newCounter: 2 } })
  })

  it('rejects a cross-origin options request before writing a challenge', async () => {
    const { env, db } = await createPasskeyTestEnv()
    const response = await registrationOptions(request('/auth/passkey/register/options', {}, { Origin: 'https://attacker.example' }), env)
    expect(response.status).toBe(403)
    expect(db.prepare('SELECT COUNT(*) AS count FROM passkey_challenges').get()).toEqual({ count: 0 })
    db.close()
  })

  it('accepts the explicit localhost Vite proxy origin during development', async () => {
    const { env, db } = await createPasskeyTestEnv({}, { domain: 'http://localhost:8788' })
    const proxiedRequest = new Request('http://localhost:8788/auth/passkey/register/options', {
      method: 'POST',
      headers: { Origin: 'http://localhost:5173', 'Sec-Fetch-Site': 'same-site' },
    })
    expect((await registrationOptions(proxiedRequest, env)).status).toBe(200)
    db.close()
  })

  it('uses a distinct nonpersonal credential label for each vault', async () => {
    const { env, db } = await createPasskeyTestEnv()
    const response = await registrationOptions(request('/auth/passkey/register/options', {}), env)
    const { userId } = await response.json() as { userId: string }
    const registrationArgs = webauthn.generateRegistrationOptions.mock.calls[0][0]
    const prefix = userId.slice(0, 8)
    expect(registrationArgs.userName).toBe(`Linger-${prefix}`)
    expect(registrationArgs.userDisplayName).toBe(`Linger (${prefix})`)
    expect(registrationArgs.userName).not.toMatch(/@|google/i)
    db.close()
  })

  it('verifies WebAuthn against the browser origin behind the Pages proxy', async () => {
    const { env, db } = await createPasskeyTestEnv({}, { domain: 'http://localhost:8788' })
    const proxyRequest = (path: string, body?: unknown, headers: HeadersInit = {}) => new Request(`http://localhost:8788${path}`, {
      method: 'POST',
      headers: { Origin: 'http://localhost:5173', 'Sec-Fetch-Site': 'same-site', 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const optionsResponse = await registrationOptions(proxyRequest('/auth/passkey/register/options', {}), env)
    const options = await optionsResponse.json() as { userId: string; prfSalt: string }
    const key = btoa(String.fromCharCode(...new Uint8Array(32))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const response = await registrationVerify(proxyRequest('/auth/passkey/register/verify', {
      response: registrationResponse,
      assertion: { ...assertionResponse, response: { ...assertionResponse.response, userHandle: base64url(options.userId) } },
      wrappedMasterKey, prfSalt: options.prfSalt,
    }, {
      Cookie: challengeCookie(optionsResponse),
      'X-Linger-Vault-Key': key, 'X-Linger-Vault-User': options.userId,
    }), env)
    expect(response.status).toBe(200)
    expect(webauthn.verifyRegistrationResponse).toHaveBeenCalledWith(expect.objectContaining({ expectedOrigin: 'http://localhost:5173', expectedRPID: 'localhost' }))
    expect(webauthn.verifyAuthenticationResponse).toHaveBeenCalledWith(expect.objectContaining({ expectedOrigin: 'http://localhost:5173', expectedRPID: 'localhost' }))
    db.close()
  })

  it('binds registration to the browser challenge cookie and consumes it once', async () => {
    const { env, db } = await createPasskeyTestEnv()
    const options = await registrationOptions(request('/auth/passkey/register/options', {}), env)
    const data = await options.json() as { userId: string; prfSalt: string }
    const key = btoa(String.fromCharCode(...new Uint8Array(32))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const body = {
      response: { ...registrationResponse, clientExtensionResults: { prf: { enabled: true } } },
      assertion: {
        ...assertionResponse,
        response: { ...assertionResponse.response, userHandle: null },
        clientExtensionResults: { prf: { enabled: true, results: { first: 'PRF_OUTPUT_MUST_NOT_PERSIST' } } },
      },
      wrappedMasterKey, prfSalt: data.prfSalt,
    }
    const headers = { 'X-Linger-Vault-Key': key, 'X-Linger-Vault-User': data.userId }
    const missingCookie = await registrationVerify(request('/auth/passkey/register/verify', body, headers), env)
    expect(missingCookie.status).toBe(400)
    expect(db.prepare('SELECT COUNT(*) AS count FROM passkey_users WHERE id = ?').get(data.userId)).toEqual({ count: 0 })

    const cookie = challengeCookie(options)
    const verified = await registrationVerify(request('/auth/passkey/register/verify', body, { ...headers, Cookie: cookie }), env)
    expect(verified.status, await verified.clone().text()).toBe(200)
    expect(webauthn.verifyRegistrationResponse).toHaveBeenCalledWith(expect.objectContaining({
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: 'example.com',
      requireUserVerification: true,
    }))
    const stored = db.prepare('SELECT credential_id, prf_salt, wrapped_master_key FROM passkey_credentials WHERE credential_id = ?').get(credentialId)
    expect(stored).toMatchObject({ credential_id: credentialId, prf_salt: data.prfSalt, wrapped_master_key: wrappedMasterKey })
    expect(JSON.stringify(stored)).not.toContain('PRF_OUTPUT_MUST_NOT_PERSIST')

    const replay = await registrationVerify(request('/auth/passkey/register/verify', body, { ...headers, Cookie: cookie }), env)
    expect(replay.status).toBe(400)
    expect(db.prepare('SELECT COUNT(*) AS count FROM passkey_credentials WHERE credential_id = ?').get(credentialId)).toEqual({ count: 1 })
    db.close()
  })

  it('uses discoverable authentication with required verification and creates only a user-bound session', async () => {
    const { env, db, userId } = await createPasskeyTestEnv()
    const now = Date.now()
    db.prepare(`INSERT INTO passkey_credentials (credential_id, user_id, public_key, counter, transports, prf_salt, wrapped_master_key, created_at)
      VALUES (?, ?, ?, 1, '[]', ?, ?, ?)`)
      .run(credentialId, userId, new Uint8Array([1, 2, 3]), prfSalt, wrappedMasterKey, now)

    const optionsResponse = await loginOptions(request('/auth/passkey/login/options', {}), env)
    expect(optionsResponse.status).toBe(200)
    expect(webauthn.generateAuthenticationOptions).toHaveBeenCalledWith(expect.objectContaining({
      rpID: 'example.com', userVerification: 'required', allowCredentials: [],
    }))
    const verified = await loginVerify(request('/auth/passkey/login/verify', {
      response: { ...assertionResponse, response: { ...assertionResponse.response, userHandle: base64url(userId) } },
    }, { Cookie: challengeCookie(optionsResponse) }), env)
    expect(verified.status).toBe(200)
    expect(await verified.json()).toMatchObject({ userId, credentialId, wrapper: { wrappedMasterKey, prfSalt } })
    expect(webauthn.verifyAuthenticationResponse).toHaveBeenCalledWith(expect.objectContaining({
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: 'example.com',
      requireUserVerification: true,
    }))
    expect(verified.headers.get('set-cookie')).toContain('linger_session=')
    db.close()
  })

  it.each([2, 1, 0])('rejects a non-advancing signature counter of %i without issuing a session', async nextCounter => {
    const { env, db, userId } = await createPasskeyTestEnv()
    try {
      seedCredential(db, userId, 2)
      const sessionsBefore = db.prepare('SELECT * FROM auth_sessions').all()
      const options = await loginOptions(request('/auth/passkey/login/options'), env)
      webauthn.verifyAuthenticationResponse.mockResolvedValueOnce({ verified: true, authenticationInfo: { newCounter: nextCounter } })
      const result = await loginVerify(request('/auth/passkey/login/verify', {
        response: { ...assertionResponse, response: { ...assertionResponse.response, userHandle: base64url(userId) } },
      }, { Cookie: challengeCookie(options) }), env)
      expect(result.status).toBe(401)
      expect(result.headers.get('set-cookie')).not.toContain('linger_session=')
      expect(db.prepare('SELECT counter FROM passkey_credentials WHERE credential_id = ?').get(credentialId)).toEqual({ counter: 2 })
      expect(db.prepare('SELECT * FROM auth_sessions').all()).toEqual(sessionsBefore)
    } finally { db.close() }
  })

  it('allows repeated logins with an authenticator that always reports a zero counter', async () => {
    const { env, db, userId } = await createPasskeyTestEnv()
    try {
      seedCredential(db, userId, 0)
      webauthn.verifyAuthenticationResponse.mockResolvedValue({ verified: true, authenticationInfo: { newCounter: 0 } })
      for (let attempt = 0; attempt < 2; attempt++) {
        const options = await loginOptions(request('/auth/passkey/login/options'), env)
        const result = await loginVerify(request('/auth/passkey/login/verify', {
          response: { ...assertionResponse, response: { ...assertionResponse.response, userHandle: base64url(userId) } },
        }, { Cookie: challengeCookie(options) }), env)
        expect(result.status).toBe(200)
        expect(result.headers.get('set-cookie')).toContain('linger_session=')
      }
      expect(db.prepare('SELECT counter FROM passkey_credentials WHERE credential_id = ?').get(credentialId)).toEqual({ counter: 0 })
      expect(db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get()).toEqual({ n: 3 })
    } finally { db.close() }
  })

  it('issues only one session when simultaneous assertions race to update the same counter', async () => {
    const { env, db, userId } = await createPasskeyTestEnv()
    const entered = deferred<void>()
    const release = deferred<void>()
    try {
      seedCredential(db, userId)
      const firstOptions = await loginOptions(request('/auth/passkey/login/options'), env)
      const secondOptions = await loginOptions(request('/auth/passkey/login/options'), env)
      webauthn.verifyAuthenticationResponse.mockImplementationOnce(async () => {
        entered.resolve()
        await release.promise
        return { verified: true, authenticationInfo: { newCounter: 2 } }
      })
      const body = { response: { ...assertionResponse, response: { ...assertionResponse.response, userHandle: base64url(userId) } } }
      const first = loginVerify(request('/auth/passkey/login/verify', body, { Cookie: challengeCookie(firstOptions) }), env)
      await entered.promise
      const winner = await loginVerify(request('/auth/passkey/login/verify', body, { Cookie: challengeCookie(secondOptions) }), env)
      release.resolve()
      const loser = await first
      expect(winner.status).toBe(200)
      expect(winner.headers.get('set-cookie')).toContain('linger_session=')
      expect(loser.status).toBe(401)
      expect(loser.headers.get('set-cookie')).not.toContain('linger_session=')
      expect(db.prepare('SELECT counter FROM passkey_credentials WHERE credential_id = ?').get(credentialId)).toEqual({ counter: 2 })
      expect(db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get()).toEqual({ n: 2 })
    } finally { release.resolve(); db.close() }
  })

  it('rejects a login challenge exactly at its expiry without checking WebAuthn or issuing a session', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-10T00:00:00Z'))
    const { env, db, userId } = await createPasskeyTestEnv()
    try {
      seedCredential(db, userId)
      const options = await loginOptions(request('/auth/passkey/login/options'), env)
      const expiresAt = db.prepare('SELECT expires_at FROM passkey_challenges').get() as { expires_at: number }
      vi.setSystemTime(expiresAt.expires_at)
      const result = await loginVerify(request('/auth/passkey/login/verify', {
        response: { ...assertionResponse, response: { ...assertionResponse.response, userHandle: base64url(userId) } },
      }, { Cookie: challengeCookie(options) }), env)
      expect(result.status).toBe(400)
      expect(webauthn.verifyAuthenticationResponse).not.toHaveBeenCalled()
      expect(result.headers.get('set-cookie')).toContain('Max-Age=0')
      expect(result.headers.get('set-cookie')).not.toContain('linger_session=')
      expect(db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get()).toEqual({ n: 1 })
    } finally { db.close() }
  })

  it('does not accept a registration challenge for login or consume it for the wrong purpose', async () => {
    const { env, db, userId } = await createPasskeyTestEnv()
    try {
      seedCredential(db, userId)
      const options = await registrationOptions(request('/auth/passkey/register/options'), env)
      const challengeBefore = db.prepare('SELECT * FROM passkey_challenges').all()
      const result = await loginVerify(request('/auth/passkey/login/verify', {
        response: { ...assertionResponse, response: { ...assertionResponse.response, userHandle: base64url(userId) } },
      }, { Cookie: challengeCookie(options) }), env)
      expect(result.status).toBe(400)
      expect(webauthn.verifyAuthenticationResponse).not.toHaveBeenCalled()
      expect(db.prepare('SELECT * FROM passkey_challenges').all()).toEqual(challengeBefore)
      expect(db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get()).toEqual({ n: 1 })
    } finally { db.close() }
  })

  it.each(['add', 'delete'] as const)('rejects a %s management grant exactly at its expiry', async action => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-10T00:00:00Z'))
    const { env, db, headers, userId, sessionId } = await createPasskeyTestEnv()
    try {
      seedCredential(db, userId)
      seedCredential(db, userId, 1, 'other-credential')
      const credentialsBefore = db.prepare('SELECT * FROM passkey_credentials').all()
      await grant(db, sessionId, action)
      vi.setSystemTime(Date.now() + 60_000)
      const result = action === 'add'
        ? await addOptions(request('/auth/passkey/add/options', {}, headers), env)
        : await deleteCredential(request('/auth/passkey/credentials/delete', { credentialId: 'other-credential' }, headers), env)
      expect(result.status).toBe(401)
      expect(webauthn.generateRegistrationOptions).not.toHaveBeenCalled()
      expect(db.prepare('SELECT COUNT(*) AS n FROM passkey_challenges').get()).toEqual({ n: 0 })
      expect(db.prepare('SELECT * FROM passkey_credentials').all()).toEqual(credentialsBefore)
    } finally { db.close() }
  })

  it.each(['add', 'delete'] as const)('does not allow a %s grant to authorize the other management action', async action => {
    const { env, db, headers, userId, sessionId } = await createPasskeyTestEnv()
    try {
      seedCredential(db, userId)
      seedCredential(db, userId, 1, 'other-credential')
      const credentialsBefore = db.prepare('SELECT * FROM passkey_credentials').all()
      await grant(db, sessionId, action)
      const result = action === 'add'
        ? await deleteCredential(request('/auth/passkey/credentials/delete', { credentialId: 'other-credential' }, headers), env)
        : await addOptions(request('/auth/passkey/add/options', {}, headers), env)
      expect(result.status).toBe(401)
      expect(db.prepare('SELECT * FROM passkey_credentials').all()).toEqual(credentialsBefore)
      expect(db.prepare('SELECT COUNT(*) AS n FROM passkey_challenges').get()).toEqual({ n: 0 })
      expect(db.prepare('SELECT action FROM passkey_management_grants WHERE session_id = ?').get(await sessionStorageId(sessionId))).toEqual({ action })
    } finally { db.close() }
  })

  it('requires a fresh, single-use assertion for credential management', async () => {
    const { env, db, headers, userId } = await createPasskeyTestEnv()
    db.prepare(`INSERT INTO passkey_credentials (credential_id, user_id, public_key, counter, transports, prf_salt, wrapped_master_key, created_at)
      VALUES (?, ?, ?, 1, '[]', ?, ?, ?)`).run(credentialId, userId, new Uint8Array([1]), prfSalt, wrappedMasterKey, Date.now())
    expect((await addOptions(request('/auth/passkey/add/options', {}, headers), env)).status).toBe(401)
    const options = await loginOptions(request('/auth/passkey/login/options', {}), env)
    const proof = await loginVerify(request('/auth/passkey/login/verify', {
      response: { ...assertionResponse, response: { ...assertionResponse.response, userHandle: base64url(userId) } },
      managementAction: 'add',
    }, { ...headers, Cookie: `${headers.Cookie}; ${challengeCookie(options)}` }), env)
    expect(proof.status).toBe(200)
    expect(proof.headers.get('set-cookie')).not.toContain('linger_session=')
    expect((await addOptions(request('/auth/passkey/add/options', {}, headers), env)).status).toBe(200)
    expect((await addOptions(request('/auth/passkey/add/options', {}, headers), env)).status).toBe(401)
    db.close()
  })

  it('requires the decrypted existing profile before adding another passkey', async () => {
    const { env, db, headers, key, userId, sessionId } = await createPasskeyTestEnv({ google_sub: 'google-identity' })
    const invalid = await addOptions(request('/auth/passkey/add/options', {}, {
      Cookie: headers.Cookie, 'X-Linger-Vault-Key': key, 'X-Linger-Vault-User': 'another-user',
    }), env)
    expect(invalid.status).toBe(401)

    await grant(db, sessionId, 'add')
    const options = await addOptions(request('/auth/passkey/add/options', {}, {
      Cookie: headers.Cookie, 'X-Linger-Vault-Key': key, 'X-Linger-Vault-User': userId,
    }), env)
    expect(options.status).toBe(200)
    const data = await options.json() as { prfSalt: string }
    const result = await addVerify(request('/auth/passkey/add/verify', {
      response: registrationResponse,
      assertion: { ...assertionResponse, response: { ...assertionResponse.response, userHandle: base64url(userId) } },
      wrappedMasterKey, prfSalt: data.prfSalt,
    }, { Cookie: `${headers.Cookie}; ${challengeCookie(options)}`, 'X-Linger-Vault-Key': key, 'X-Linger-Vault-User': userId }), env)
    expect(result.status).toBe(200)
    expect(db.prepare('SELECT user_id FROM passkey_credentials WHERE credential_id = ?').get(credentialId)).toEqual({ user_id: userId })
    db.close()
  })

  it('allows an omitted userHandle for the known credential used to add a passkey', async () => {
    const { env, db, headers, userId, sessionId } = await createPasskeyTestEnv()
    await grant(db, sessionId, 'add')
    const options = await addOptions(request('/auth/passkey/add/options', {}, headers), env)
    const data = await options.json() as { prfSalt: string }
    const result = await addVerify(request('/auth/passkey/add/verify', {
      response: registrationResponse,
      assertion: { ...assertionResponse, response: { ...assertionResponse.response, userHandle: null } },
      wrappedMasterKey, prfSalt: data.prfSalt,
    }, { ...headers, Cookie: `${headers.Cookie}; ${challengeCookie(options)}` }), env)
    expect(result.status).toBe(200)
    expect(db.prepare('SELECT user_id FROM passkey_credentials WHERE credential_id = ?').get(credentialId)).toEqual({ user_id: userId })
    db.close()
  })

  it('rejects a present mismatched userHandle when adding a passkey', async () => {
    const { env, db, headers, sessionId } = await createPasskeyTestEnv()
    await grant(db, sessionId, 'add')
    const options = await addOptions(request('/auth/passkey/add/options', {}, headers), env)
    const data = await options.json() as { prfSalt: string }
    const result = await addVerify(request('/auth/passkey/add/verify', {
      response: registrationResponse,
      assertion: { ...assertionResponse, response: { ...assertionResponse.response, userHandle: base64url('wrong-user') } },
      wrappedMasterKey, prfSalt: data.prfSalt,
    }, { ...headers, Cookie: `${headers.Cookie}; ${challengeCookie(options)}` }), env)
    expect(result.status).toBe(400)
    expect(db.prepare('SELECT COUNT(*) AS count FROM passkey_credentials').get()).toEqual({ count: 0 })
    db.close()
  })

  it('does not add a credential if its session is revoked during WebAuthn verification', async () => {
    const { env, db, headers, userId, sessionId } = await createPasskeyTestEnv()
    await grant(db, sessionId, 'add')
    const options = await addOptions(request('/auth/passkey/add/options', {}, headers), env)
    const data = await options.json() as { prfSalt: string }
    webauthn.verifyAuthenticationResponse.mockImplementationOnce(async () => {
      db.prepare('UPDATE auth_sessions SET user_id = NULL, revoked = 1 WHERE id = ?').run(await sessionStorageId(sessionId))
      return { verified: true, authenticationInfo: { newCounter: 2 } }
    })
    const result = await addVerify(request('/auth/passkey/add/verify', {
      response: registrationResponse,
      assertion: { ...assertionResponse, response: { ...assertionResponse.response, userHandle: base64url(userId) } },
      wrappedMasterKey, prfSalt: data.prfSalt,
    }, { ...headers, Cookie: `${headers.Cookie}; ${challengeCookie(options)}` }), env)
    expect(result.status).toBe(400)
    expect(db.prepare('SELECT COUNT(*) AS count FROM passkey_credentials').get()).toEqual({ count: 0 })
    db.close()
  })

  it('lists credentials and deletes another credential while protecting current and final credentials', async () => {
    const { env, db, headers, userId, sessionId, key } = await createPasskeyTestEnv()
    const otherCredentialId = 'other-credential-id'
    const now = Date.now()
    db.prepare(`INSERT INTO passkey_credentials (credential_id, user_id, public_key, counter, transports, prf_salt, wrapped_master_key, created_at)
      VALUES (?, ?, ?, 1, '[]', ?, ?, ?)`).run(credentialId, userId, new Uint8Array([1]), prfSalt, wrappedMasterKey, now)
    db.prepare(`INSERT INTO passkey_credentials (credential_id, user_id, public_key, counter, transports, prf_salt, wrapped_master_key, created_at)
      VALUES (?, ?, ?, 1, '[]', ?, ?, ?)`).run(otherCredentialId, userId, new Uint8Array([2]), prfSalt, wrappedMasterKey, now + 1)
    db.prepare('UPDATE auth_sessions SET credential_id = ? WHERE id = ?').run(credentialId, await sessionStorageId(sessionId))

    const listed = await listCredentials(request('/auth/passkey/credentials/list', {}, headers), env)
    expect(listed.status).toBe(200)
    expect(await listed.json()).toEqual({
      credentials: [{ credentialId, createdAt: now }, { credentialId: otherCredentialId, createdAt: now + 1 }],
      currentCredentialId: credentialId,
    })
    const currentDelete = await deleteCredential(request('/auth/passkey/credentials/delete', { credentialId }, headers), env)
    expect(currentDelete.status).toBe(409)
    await grant(db, sessionId, 'delete')
    const lastDelete = await deleteCredential(request('/auth/passkey/credentials/delete', { credentialId: otherCredentialId }, headers), env)
    expect(lastDelete.status).toBe(200)
    expect(await lastDelete.json()).toEqual({ ok: true })
    expect(db.prepare('SELECT user_id, credential_id, revoked FROM auth_sessions WHERE id = ?').get(await sessionStorageId(sessionId)))
      .toEqual({ user_id: userId, credential_id: credentialId, revoked: 0 })
    expect(db.prepare('SELECT credential_id FROM passkey_credentials WHERE user_id = ?').all(userId)).toEqual([{ credential_id: credentialId }])

    const unboundSessionId = 'second-session'
    await createPasskeySession(unboundSessionId, userId, env)
    await grant(db, unboundSessionId, 'delete')
    const lastCredentialDelete = await deleteCredential(request('/auth/passkey/credentials/delete', { credentialId }, {
      ...headers, Cookie: `linger_session=${unboundSessionId}`,
    }), env)
    expect(lastCredentialDelete.status).toBe(409)
    expect(key).toBeTruthy()
    db.close()
  })

  it('requires same origin, matching unlocked user, and a vault key for credential management', async () => {
    const { env, db, headers, userId } = await createPasskeyTestEnv()
    const addCredential = () => db.prepare(`INSERT INTO passkey_credentials (credential_id, user_id, public_key, counter, transports, prf_salt, wrapped_master_key, created_at)
      VALUES (?, ?, ?, 1, '[]', ?, ?, ?)`).run('listed-credential', userId, new Uint8Array([1]), prfSalt, wrappedMasterKey, Date.now())
    addCredential()
    expect((await listCredentials(request('/auth/passkey/credentials/list', {}, { ...headers, Origin: 'https://attacker.example' }), env)).status).toBe(403)
    expect((await listCredentials(request('/auth/passkey/credentials/list', {}, { ...headers, 'X-Linger-Vault-User': 'other-user' }), env)).status).toBe(401)
    expect((await listCredentials(request('/auth/passkey/credentials/list', {}, { Cookie: headers.Cookie, 'X-Linger-Vault-User': userId }), env)).status).toBe(401)
    db.close()
  })

  it('requires discoverable login userHandle to match and rejects deleted credential sessions', async () => {
    const { env, db, userId, key } = await createPasskeyTestEnv()
    db.prepare(`INSERT INTO passkey_credentials (credential_id, user_id, public_key, counter, transports, prf_salt, wrapped_master_key, created_at)
      VALUES (?, ?, ?, 1, '[]', ?, ?, ?)`).run(credentialId, userId, new Uint8Array([1]), prfSalt, wrappedMasterKey, Date.now())
    const options = await loginOptions(request('/auth/passkey/login/options', {}), env)
    const mismatch = await loginVerify(request('/auth/passkey/login/verify', {
      response: { ...assertionResponse, response: { ...assertionResponse.response, userHandle: base64url('wrong-user') } },
    }, { Cookie: challengeCookie(options) }), env)
    expect(mismatch.status).toBe(401)

    const options2 = await loginOptions(request('/auth/passkey/login/options', {}), env)
    const valid = await loginVerify(request('/auth/passkey/login/verify', {
      response: { ...assertionResponse, response: { ...assertionResponse.response, userHandle: base64url(userId) } },
    }, { Cookie: challengeCookie(options2) }), env)
    expect(valid.status).toBe(200)
    const sessionCookie = valid.headers.get('set-cookie')?.match(/linger_session=([^;]+)/)?.[1]
    expect(sessionCookie).toBeTruthy()
    db.prepare('DELETE FROM passkey_credentials WHERE credential_id = ?').run(credentialId)
    const { readD1Session } = await import('../../functions/_shared/authStore')
    expect(await readD1Session(decodeURIComponent(sessionCookie!), { ...env, AUTH_DB: env.AUTH_DB! }, key)).toBeNull()
    db.close()
  })
})
