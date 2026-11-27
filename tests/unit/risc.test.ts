import { createHash, webcrypto } from 'node:crypto'
import { describe, expect, it, vi, beforeEach, afterEach, beforeAll } from 'vitest'
import { onRequestPost } from '../../functions/auth/risc'
import { createPasskeyTestEnv } from '../helpers/passkeyAuth'
import { createPasskeySession, getPasskeySessionUserId, saveD1Session } from '../../functions/_shared/authStore'
import { encodeVaultBytes } from '../../functions/_shared/vaultCrypto'

// --- helpers ---

interface JwkKey {
  kty: string
  kid: string
  n: string
  e: string
}

function encodeBase64Url(obj: object): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function makeJwt(header: object, payload: object): string {
  const h = encodeBase64Url(header)
  const p = encodeBase64Url(payload)
  return `${h}.${p}.fakesig`
}

function bufferToBase64Url(buf: ArrayBufferLike): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function base64UrlToBytes(input: string): Uint8Array {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4))
  const binary = atob((input + pad).replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function makeSignedJwt(header: object, payload: object, privateKey: CryptoKey): Promise<string> {
  const signingInput = `${encodeBase64Url(header)}.${encodeBase64Url(payload)}`
  const sig = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    privateKey,
    new TextEncoder().encode(signingInput),
  )
  return `${signingInput}.${bufferToBase64Url(sig)}`
}

const VALID_HEADER = { alg: 'RS256', kid: 'key-1', typ: 'secevent+jwt' }
const TEST_PEPPER = 'test-risc-pepper-value-at-least-32-chars'

function validPayload(overrides?: object) {
  return {
    iss: 'https://accounts.google.com',
    aud: 'client-id',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    jti: 'unique-jti',
    events: {
      'https://schemas.openid.net/secevent/risc/event-type/sessions-revoked': {
        subject: { subject_type: 'iss-sub', iss: 'https://accounts.google.com', sub: '12345' },
        hint_identifier: 'user@example.com',
      },
    },
    ...overrides,
  }
}

const FAKE_JWKS = { keys: [{ kty: 'RSA', kid: 'key-1', n: 'fake-n', e: 'AQAB' }] }

function makeMockCache(cachedResponse: Response | null = null) {
  return {
    match: vi.fn().mockResolvedValue(cachedResponse),
    put: vi.fn().mockResolvedValue(undefined),
  }
}

function mockJwks(cache = makeMockCache()) {
  vi.stubGlobal('caches', { open: vi.fn().mockResolvedValue(cache) })
  vi.stubGlobal('fetch', vi.fn().mockImplementation(() =>
    Promise.resolve(new Response(JSON.stringify(FAKE_JWKS), { status: 200, headers: { 'Content-Type': 'application/json' } })),
  ))
  return cache
}

// Stubs only the network (fetch/caches) boundary, leaving `crypto` untouched so
// crypto.subtle.importKey/verify run for real against the given JWK set.
function stubJwksFetch(keys: JwkKey[], cache = makeMockCache()) {
  vi.stubGlobal('caches', { open: vi.fn().mockResolvedValue(cache) })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ keys }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  ))
  return cache
}

const realSubtle = webcrypto.subtle

function mockCrypto(verifyResult: boolean) {
  const importKey = vi.fn((format: string, keyData: unknown, algorithm: unknown, extractable: boolean, keyUsages: KeyUsage[]) =>
    format === 'jwk'
      ? Promise.resolve('fake-key')
      : realSubtle.importKey(format as never, keyData as never, algorithm as never, extractable, keyUsages))
  const verify = vi.fn().mockResolvedValue(verifyResult)
  const subtle = new Proxy(realSubtle, {
    get(target, prop) {
      if (prop === 'importKey') return importKey
      if (prop === 'verify') return verify
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  vi.stubGlobal('crypto', {
    randomUUID: webcrypto.randomUUID.bind(webcrypto),
    getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
    subtle,
  })
}

function makeEnv(sessionsOverrides?: object) {
  return {
    SESSIONS: {
      get: vi.fn().mockResolvedValue(null),
      delete: vi.fn(),
      put: vi.fn(),
      list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
      ...sessionsOverrides,
    },
    GOOGLE_CLIENT_ID: 'client-id',
    GOOGLE_CLIENT_SECRET: 'secret',
    SESSION_DOMAIN: 'https://example.com',
  }
}

function postRisc(body: string, env: Pick<ReturnType<typeof makeEnv>, 'GOOGLE_CLIENT_ID'>) {
  const request = new Request('http://localhost/auth/risc', { method: 'POST', body })
  return onRequestPost({ request, env } as any)
}

// --- tests ---

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
  vi.stubGlobal('caches', { open: vi.fn().mockResolvedValue(makeMockCache()) })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('onRequestPost (RISC webhook)', () => {
  it('returns 400 on empty body', async () => {
    const response = await postRisc('', makeEnv())
    expect(response.status).toBe(400)
    const body = await response.json() as { error: string }
    expect(body.error).toContain('Empty request body')
  })

  it('returns 400 for a JWT with wrong number of parts', async () => {
    const response = await postRisc('only.two', makeEnv())
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid SET' })
  })

  it('returns 400 when typ is missing', async () => {
    const jwt = makeJwt({ alg: 'RS256', kid: 'key-1' }, validPayload())
    const response = await postRisc(jwt, makeEnv())
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid SET' })
  })

  it('returns 400 when typ is not secevent+jwt', async () => {
    const jwt = makeJwt({ alg: 'RS256', kid: 'key-1', typ: 'JWT' }, validPayload())
    const response = await postRisc(jwt, makeEnv())
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid SET' })
  })

  it('returns 400 when alg is not RS256', async () => {
    const jwt = makeJwt({ alg: 'HS256', kid: 'key-1', typ: 'secevent+jwt' }, validPayload())
    const response = await postRisc(jwt, makeEnv())
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid SET' })
  })

  it('returns 400 when kid is missing from header', async () => {
    const jwt = makeJwt({ alg: 'RS256', typ: 'secevent+jwt' }, validPayload())
    const response = await postRisc(jwt, makeEnv())
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid SET' })
  })

  it('returns 400 when JWKS fetch fails', async () => {
    mockCrypto(true)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('error', { status: 500 })))
    const jwt = makeJwt(VALID_HEADER, validPayload())
    const response = await postRisc(jwt, makeEnv())
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid SET' })
  })

  it('returns 400 when kid does not match any JWKS key', async () => {
    mockCrypto(true)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ keys: [{ kty: 'RSA', kid: 'other-key', n: 'n', e: 'e' }] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }),
    ))
    const jwt = makeJwt(VALID_HEADER, validPayload())
    const response = await postRisc(jwt, makeEnv())
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid SET' })
  })

  it('returns 400 when signature verification fails', async () => {
    mockCrypto(false)
    mockJwks()
    const jwt = makeJwt(VALID_HEADER, validPayload())
    const response = await postRisc(jwt, makeEnv())
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid SET' })
  })

  it('returns 400 when iss does not match Google', async () => {
    mockCrypto(true)
    mockJwks()
    const jwt = makeJwt(VALID_HEADER, validPayload({ iss: 'https://evil.com' }))
    const response = await postRisc(jwt, makeEnv())
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid SET' })
  })

  it('returns 400 when aud does not match client ID', async () => {
    mockCrypto(true)
    mockJwks()
    const jwt = makeJwt(VALID_HEADER, validPayload({ aud: 'wrong-client' }))
    const response = await postRisc(jwt, makeEnv())
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid SET' })
  })

  it('returns 400 when iat is missing', async () => {
    mockCrypto(true)
    mockJwks()
    const payload = validPayload()
    delete (payload as Record<string, unknown>).iat
    const jwt = makeJwt(VALID_HEADER, payload)
    const response = await postRisc(jwt, makeEnv())
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid SET' })
  })

  it('returns 400 when iat is more than 1 hour old', async () => {
    mockCrypto(true)
    mockJwks()
    const jwt = makeJwt(VALID_HEADER, validPayload({ iat: Math.floor(Date.now() / 1000) - 3601 }))
    const response = await postRisc(jwt, makeEnv())
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid SET' })
  })

  it('returns 400 when iat is more than 60s in the future', async () => {
    mockCrypto(true)
    mockJwks()
    const jwt = makeJwt(VALID_HEADER, validPayload({ iat: Math.floor(Date.now() / 1000) + 61 }))
    const response = await postRisc(jwt, makeEnv())
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid SET' })
  })

  it('returns 400 when token is expired', async () => {
    mockCrypto(true)
    mockJwks()
    const jwt = makeJwt(VALID_HEADER, validPayload({ exp: Math.floor(Date.now() / 1000) - 1 }))
    const response = await postRisc(jwt, makeEnv())
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid SET' })
  })

  it('returns a retryable error without D1 and does not enumerate legacy KV', async () => {
    mockCrypto(true)
    mockJwks()
    const env = makeEnv()
    const jwt = makeJwt(VALID_HEADER, validPayload())

    const response = await postRisc(jwt, env)
    expect(response.status).toBe(503)
    expect(env.SESSIONS.list).not.toHaveBeenCalled()
    expect(env.SESSIONS.delete).not.toHaveBeenCalled()
  })

  it('returns a retryable error for an email-only event without enumerating sessions', async () => {
    mockCrypto(true)
    mockJwks()
    const env = makeEnv()
    const payload = validPayload({
      events: {
        'https://schemas.openid.net/secevent/risc/event-type/sessions-revoked': {
          hint_identifier: 'user@example.com',
        },
      },
    })

    const response = await postRisc(makeJwt(VALID_HEADER, payload), env)

    expect(response.status).toBe(503)
    expect(response.headers.get('Retry-After')).toBe('1')
    expect(await response.json()).toEqual({ error: 'Session revocation temporarily unavailable' })
    expect(env.SESSIONS.list).not.toHaveBeenCalled()
    expect(env.SESSIONS.delete).not.toHaveBeenCalled()
  })

  it('rolls back revocation and the receipt on failure and accepts redelivery', async () => {
    mockCrypto(true)
    mockJwks()
    const { env, db, sessionId } = await createPasskeyTestEnv({ google_sub: '12345' }, { riscPepper: TEST_PEPPER })
    try {
      db.exec(`CREATE TRIGGER fail_receipt BEFORE INSERT ON risc_processed_events
        BEGIN SELECT RAISE(ABORT, 'receipt failure'); END`)
      const jwt = makeJwt(VALID_HEADER, validPayload())
      expect((await postRisc(jwt, env)).status).toBe(503)
      expect(await getPasskeySessionUserId(sessionId, env)).toBeTruthy()
      expect(db.prepare('SELECT * FROM risc_processed_events').all()).toEqual([])

      db.exec('DROP TRIGGER fail_receipt')
      expect((await postRisc(jwt, env)).status).toBe(202)
      expect(await getPasskeySessionUserId(sessionId, env)).toBeNull()
    } finally { db.close() }
  })

  it('uses cached JWKS and skips fetch on cache hit', async () => {
    mockCrypto(true)
    const cachedResp = new Response(JSON.stringify(FAKE_JWKS), { headers: { 'Content-Type': 'application/json' } })
    const cache = mockJwks(makeMockCache(cachedResp))
    const jwt = makeJwt(VALID_HEADER, validPayload())

    await postRisc(jwt, makeEnv())

    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
    expect(cache.put).not.toHaveBeenCalled()
  })

  it('fetches and caches JWKS on cache miss', async () => {
    mockCrypto(true)
    const cache = mockJwks()
    const jwt = makeJwt(VALID_HEADER, validPayload())

    await postRisc(jwt, makeEnv())

    expect(vi.mocked(fetch)).toHaveBeenCalledOnce()
    expect(cache.put).toHaveBeenCalledOnce()
  })

  it('force-refreshes JWKS when kid is not found in cache', async () => {
    mockCrypto(true)
    const staleJwks = { keys: [{ kty: 'RSA', kid: 'old-key', n: 'n', e: 'e' }] }
    const cachedResp = new Response(JSON.stringify(staleJwks), { headers: { 'Content-Type': 'application/json' } })
    const cache = mockJwks(makeMockCache(cachedResp))
    const jwt = makeJwt(VALID_HEADER, validPayload({ events: { 'unknown-event': {} } })) // kid: 'key-1', not in stale cache

    const response = await postRisc(jwt, makeEnv())

    // Should have fetched fresh JWKS (kid found after refresh → 202)
    expect(vi.mocked(fetch)).toHaveBeenCalledOnce()
    expect(response.status).toBe(202)
    expect(cache.put).toHaveBeenCalledOnce()
  })

  it('accepts aud as an array containing the client ID', async () => {
    mockCrypto(true)
    mockJwks()
    const jwt = makeJwt(VALID_HEADER, validPayload({ aud: ['client-id', 'other'], events: { 'unknown-event': {} } }))
    const response = await postRisc(jwt, makeEnv())
    expect(response.status).toBe(202)
  })

  it('returns 202 with handled:0 for unknown event types', async () => {
    mockCrypto(true)
    mockJwks()
    const payload = validPayload({
      events: { 'https://schemas.openid.net/secevent/unknown/event': {} },
    })
    const jwt = makeJwt(VALID_HEADER, payload)
    const response = await postRisc(jwt, makeEnv())
    const body = await response.json() as { handled: number; revoked: number }
    expect(response.status).toBe(202)
    expect(body).toMatchObject({ handled: 0, revoked: 0 })
  })

  it.each([
    ['risc', 'sessions-revoked'],
    ['oauth', 'tokens-revoked'],
    ['risc', 'account-disabled'],
    ['risc', 'account-credential-change-required'],
  ])('revokes sessions by subject for event %s/%s', async (ns, eventSlug) => {
    mockCrypto(true)
    mockJwks()
    const payload = validPayload({
      events: {
        [`https://schemas.openid.net/secevent/${ns}/event-type/${eventSlug}`]: {
          subject: { subject_type: 'iss-sub', iss: 'https://accounts.google.com', sub: '12345' },
        },
      },
    })
    const { env, db, sessionId } = await createPasskeyTestEnv({ google_sub: '12345' }, { riscPepper: TEST_PEPPER })
    try {
      const response = await postRisc(makeJwt(VALID_HEADER, payload), env)
      expect(response.status).toBe(202)
      expect(await response.json()).toMatchObject({ revoked: 1 })
      expect(await getPasskeySessionUserId(sessionId, env)).toBeNull()
    } finally { db.close() }
  })

  it('rejects missing or empty jti with 400', async () => {
    mockCrypto(true)
    mockJwks()
    const missingJti = validPayload()
    delete (missingJti as Record<string, unknown>).jti
    expect((await postRisc(makeJwt(VALID_HEADER, missingJti), makeEnv())).status).toBe(400)
    expect((await postRisc(makeJwt(VALID_HEADER, validPayload({ jti: '   ' })), makeEnv())).status).toBe(400)
  })

  it('rejects payloads larger than 64 KiB with 413', async () => {
    const oversized = 'a'.repeat(64 * 1024 + 1)
    const response = await postRisc(oversized, makeEnv())
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'Request too large' })
  })

  it('passes an AbortSignal timeout when fetching JWKS', async () => {
    mockCrypto(true)
    const cache = mockJwks()
    expect(cache).toBeTruthy()
    await postRisc(makeJwt(VALID_HEADER, validPayload()), makeEnv())
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit]
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('retries old incomplete receipts once and preserves sessions created after commit', async () => {
    mockCrypto(true)
    mockJwks()
    const { env, db, sessionId, userId } = await createPasskeyTestEnv({ google_sub: '12345' }, { riscPepper: TEST_PEPPER })
    try {
      const jti = 'replay-jti-d1'
      const hash = createHash('sha256').update(`linger-risc-jti/v1:${jti}`).digest('hex')
      db.prepare('INSERT INTO risc_processed_events (jti_hash, expires_at) VALUES (?, ?)').run(`sha256:${hash}`, Date.now() + 1000)
      const d1Jwt = makeJwt(VALID_HEADER, validPayload({ jti }))
      const first = await postRisc(d1Jwt, env)
      expect(await first.json()).toEqual({ ok: true, handled: 1, revoked: 1 })
      expect(await getPasskeySessionUserId(sessionId, env)).toBeNull()

      // A new session created after the first event must not be revoked by replaying the same jti.
      const newSessionId = 'fresh-session-after-risc'
      await createPasskeySession(newSessionId, userId, env)
      const second = await postRisc(d1Jwt, env)
      expect(second.status).toBe(202)
      expect(await second.json()).toEqual({ ok: true, handled: 0, revoked: 0, duplicate: true })
      expect(await getPasskeySessionUserId(newSessionId, env)).toBe(userId)
    } finally { db.close() }
  })

  it('leaves sessions in place when the configuration is missing and succeeds after it is restored', async () => {
    mockCrypto(true)
    mockJwks()
    const { env, db, sessionId } = await createPasskeyTestEnv({ google_sub: '12345' }, { riscPepper: TEST_PEPPER })
    try {
      const jwt = makeJwt(VALID_HEADER, validPayload({ jti: 'retryable-jti' }))
      const failed = await postRisc(jwt, { ...env, RISC_INDEX_PEPPER: undefined } as typeof env)
      expect(failed.status).toBe(503)
      expect(await getPasskeySessionUserId(sessionId, env)).toBeTruthy()
      expect(db.prepare('SELECT * FROM risc_processed_events').all()).toEqual([])

      const retried = await postRisc(jwt, env)
      expect(retried.status).toBe(202)
      expect(await retried.json()).toEqual({ ok: true, handled: 1, revoked: 1 })
      expect(await getPasskeySessionUserId(sessionId, env)).toBeNull()
    } finally { db.close() }
  })

  it('targets only the matching blind-indexed user', async () => {
    mockCrypto(true)
    mockJwks()
    const fixture = await createPasskeyTestEnv({ google_sub: '12345' }, { userId: 'user-a', sessionId: 'session-a' })
    try {
      const { db, key } = fixture
      const env = { ...fixture.env, RISC_INDEX_PEPPER: TEST_PEPPER }
      const { getSession, saveSession } = await import('../../functions/_shared/session')
      const sessionA = (await getSession('session-a', env, key))!
      sessionA.folder_id = 'folder-a'
      await saveSession('session-a', sessionA, env)
      db.prepare('INSERT INTO google_refresh_vault (user_id, envelope, updated_at) VALUES (?, ?, ?)').run('user-a', 'v1.refresh-a', Date.now())

      const userB = 'user-b'
      const sessionB = 'session-b'
      const keyB = encodeVaultBytes(new Uint8Array(32).fill(9))
      db.prepare('INSERT INTO passkey_users (id, created_at) VALUES (?, ?)').run(userB, Date.now())
      await createPasskeySession(sessionB, userB, env)
      await saveD1Session(sessionB, { user_id: userB, vault_key: keyB, google_sub: 'other-sub' }, { ...env, AUTH_DB: env.AUTH_DB! })
      db.prepare('INSERT INTO google_refresh_vault (user_id, envelope, updated_at) VALUES (?, ?, ?)').run(userB, 'v1.refresh-b', Date.now())

      const legacyUser = 'user-legacy'
      const legacySession = 'session-legacy'
      db.prepare('INSERT INTO passkey_users (id, created_at) VALUES (?, ?)').run(legacyUser, Date.now())
      await createPasskeySession(legacySession, legacyUser, env)
      db.prepare('INSERT INTO google_refresh_vault (user_id, envelope, updated_at) VALUES (?, ?, ?)').run(legacyUser, 'v1.refresh-legacy', Date.now())

      const response = await postRisc(makeJwt(VALID_HEADER, validPayload({ jti: 'targeted-jti' })), env)
      expect(response.status).toBe(202)
      expect(await response.json()).toEqual({ ok: true, handled: 1, revoked: 1 })

      expect(await getPasskeySessionUserId('session-a', env)).toBeNull()
      expect(await getPasskeySessionUserId(legacySession, env)).toBe(legacyUser)
      expect(await getPasskeySessionUserId(sessionB, env)).toBe(userB)
      expect(db.prepare('SELECT user_id FROM google_refresh_vault ORDER BY user_id').all()).toEqual([{ user_id: userB }, { user_id: legacyUser }])
    } finally { fixture.db.close() }
  })
})

// Every case above stubs `crypto.subtle.verify` to a fixed true/false, so the
// actual RSASSA-PKCS1-v1_5 verification code path is never exercised. These
// tests leave `crypto` untouched — only the network (fetch/caches) boundary is
// stubbed — so importKey/verify run against a real key pair and a real signature.
describe('onRequestPost (RISC webhook) — real RSA signature verification', () => {
  let privateKey: CryptoKey
  let publicJwk: JsonWebKey

  beforeAll(async () => {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    ) as CryptoKeyPair
    privateKey = keyPair.privateKey
    publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey) as JsonWebKey
  })

  it('accepts a JWT with a genuine RS256 signature over the published JWK', async () => {
    stubJwksFetch([{ kty: 'RSA', kid: 'key-1', n: publicJwk.n!, e: publicJwk.e! }])
    const jwt = await makeSignedJwt(VALID_HEADER, validPayload({ events: { 'unknown-event': {} } }), privateKey)

    const response = await postRisc(jwt, makeEnv())

    expect(response.status).toBe(202)
  })

  it('rejects a JWT whose signature bytes have been tampered with', async () => {
    stubJwksFetch([{ kty: 'RSA', kid: 'key-1', n: publicJwk.n!, e: publicJwk.e! }])
    const jwt = await makeSignedJwt(VALID_HEADER, validPayload(), privateKey)
    const [headerB64, payloadB64, signatureB64] = jwt.split('.')
    // Flip a bit in a byte from the middle of the raw signature, not a base64url
    // character — the last char of an RSA-2048 (256-byte) signature only encodes
    // 2 bits, so flipping *that* char can round-trip to the same decoded byte and
    // leave verification (wrongly) passing.
    const sigBytes = base64UrlToBytes(signatureB64)
    sigBytes[Math.floor(sigBytes.length / 2)] ^= 0xff
    const tampered = `${headerB64}.${payloadB64}.${bufferToBase64Url(sigBytes.buffer)}`

    const response = await postRisc(tampered, makeEnv())

    expect(response.status).toBe(400)
  })

  it('rejects a JWT whose payload has been tampered with after signing', async () => {
    stubJwksFetch([{ kty: 'RSA', kid: 'key-1', n: publicJwk.n!, e: publicJwk.e! }])
    const jwt = await makeSignedJwt(VALID_HEADER, validPayload(), privateKey)
    const [headerB64, , signatureB64] = jwt.split('.')
    // Keep every claim verifyJwt itself checks (iss/aud/iat/exp) valid, so a
    // rejection can only come from the signature no longer matching the
    // payload — changing `aud` instead would get rejected by the aud check
    // regardless of whether signature verification even ran.
    const tamperedPayload = encodeBase64Url(validPayload({
      events: {
        'https://schemas.openid.net/secevent/risc/event-type/sessions-revoked': {
          subject: { subject_type: 'iss-sub', iss: 'https://accounts.google.com', sub: '12345' },
          hint_identifier: 'attacker@example.com',
        },
      },
    }))
    const tampered = `${headerB64}.${tamperedPayload}.${signatureB64}`

    const response = await postRisc(tampered, makeEnv())

    expect(response.status).toBe(400)
  })

  it('rejects a JWT signed by a key other than the one published under its kid', async () => {
    const otherKeyPair = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    ) as CryptoKeyPair
    // JWKS still publishes the original public key under kid 'key-1'.
    stubJwksFetch([{ kty: 'RSA', kid: 'key-1', n: publicJwk.n!, e: publicJwk.e! }])
    const jwt = await makeSignedJwt(VALID_HEADER, validPayload(), otherKeyPair.privateKey)

    const response = await postRisc(jwt, makeEnv())

    expect(response.status).toBe(400)
  })
})
