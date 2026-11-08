import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPasskeyTestEnv } from '../helpers/passkeyAuth'

const webauthn = vi.hoisted(() => ({
  generateAuthenticationOptions: vi.fn(),
  generateRegistrationOptions: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
  verifyRegistrationResponse: vi.fn(),
}))

vi.mock('@simplewebauthn/server', () => webauthn)

import { addOptions, addVerify, loginOptions, loginVerify, recoverSession, registrationOptions, registrationVerify } from '../../functions/_shared/passkeys'

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
        response: { ...assertionResponse.response, userHandle: base64url(data.userId) },
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

  it('requires the decrypted existing profile before adding another passkey', async () => {
    const { env, db, headers, key, userId } = await createPasskeyTestEnv({ google_sub: 'google-identity' })
    const invalid = await addOptions(request('/auth/passkey/add/options', {}, {
      Cookie: headers.Cookie, 'X-Linger-Vault-Key': key, 'X-Linger-Vault-User': 'another-user',
    }), env)
    expect(invalid.status).toBe(401)

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

  it('recovers a session only with the key that decrypts that user profile', async () => {
    const { env, db, key, userId } = await createPasskeyTestEnv()
    const wrong = btoa(String.fromCharCode(...new Uint8Array(32).fill(7))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const rejected = await recoverSession(request('/auth/passkey/recover', {}, {
      'X-Linger-Vault-Key': wrong, 'X-Linger-Vault-User': userId,
    }), env)
    expect(rejected.status).toBe(401)
    expect(await rejected.json()).toEqual({ error: 'Recovery failed' })

    const recovered = await recoverSession(request('/auth/passkey/recover', {}, {
      'X-Linger-Vault-Key': key, 'X-Linger-Vault-User': userId,
    }), env)
    expect(recovered.status).toBe(200)
    expect(await recovered.json()).toEqual({ userId })
    expect(recovered.headers.get('set-cookie')).toContain('linger_session=')
    db.close()
  })
})
