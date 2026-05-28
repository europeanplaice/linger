import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { onRequestPost } from '../../functions/auth/risc'

// --- helpers ---

function encodeBase64Url(obj: object): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function makeJwt(header: object, payload: object): string {
  const h = encodeBase64Url(header)
  const p = encodeBase64Url(payload)
  return `${h}.${p}.fakesig`
}

const VALID_HEADER = { alg: 'RS256', kid: 'key-1', typ: 'secevent+jwt' }

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
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
    new Response(JSON.stringify(FAKE_JWKS), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  ))
  return cache
}

function mockCrypto(verifyResult: boolean) {
  vi.stubGlobal('crypto', {
    subtle: {
      importKey: vi.fn().mockResolvedValue('fake-key'),
      verify: vi.fn().mockResolvedValue(verifyResult),
    },
  })
}

function makeEnv(sessionsOverrides?: object) {
  return {
    SESSIONS: { get: vi.fn().mockResolvedValue(null), delete: vi.fn(), put: vi.fn(), ...sessionsOverrides },
    GOOGLE_CLIENT_ID: 'client-id',
    GOOGLE_CLIENT_SECRET: 'secret',
    SESSION_DOMAIN: 'https://example.com',
  }
}

function postRisc(body: string, env: ReturnType<typeof makeEnv>) {
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

  it('returns 202 and revokes all sessions for the user', async () => {
    mockCrypto(true)
    mockJwks()
    const del = vi.fn()
    const env = makeEnv({
      get: vi.fn().mockResolvedValue(JSON.stringify(['sid1', 'sid2'])),
      delete: del,
    })
    const jwt = makeJwt(VALID_HEADER, validPayload())

    const response = await postRisc(jwt, env)
    const body = await response.json() as { ok: boolean; handled: number; revoked: number }

    expect(response.status).toBe(202)
    expect(body).toMatchObject({ ok: true, handled: 1, revoked: 1 })
    expect(del).toHaveBeenCalledWith('session:sid1')
    expect(del).toHaveBeenCalledWith('session:sid2')
    expect(del).toHaveBeenCalledWith('email_sessions:user@example.com')
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
    const jwt = makeJwt(VALID_HEADER, validPayload()) // kid: 'key-1', not in stale cache

    const response = await postRisc(jwt, makeEnv())

    // Should have fetched fresh JWKS (kid found after refresh → 202)
    expect(vi.mocked(fetch)).toHaveBeenCalledOnce()
    expect(response.status).toBe(202)
    expect(cache.put).toHaveBeenCalledOnce()
  })

  it('accepts aud as an array containing the client ID', async () => {
    mockCrypto(true)
    mockJwks()
    const jwt = makeJwt(VALID_HEADER, validPayload({ aud: ['client-id', 'other'] }))
    const response = await postRisc(jwt, makeEnv())
    expect(response.status).toBe(202)
  })

  it('returns 202 with revoked:0 when no email hint is present', async () => {
    mockCrypto(true)
    mockJwks()
    const payload = validPayload({
      events: {
        'https://schemas.openid.net/secevent/risc/event-type/sessions-revoked': {
          subject: { subject_type: 'iss-sub', iss: 'https://accounts.google.com', sub: '12345' },
        },
      },
    })
    const jwt = makeJwt(VALID_HEADER, payload)
    const response = await postRisc(jwt, makeEnv())
    const body = await response.json() as { handled: number; revoked: number }
    expect(response.status).toBe(202)
    expect(body).toMatchObject({ handled: 1, revoked: 0 })
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
  ])('revokes sessions for event %s/%s', async (ns, eventSlug) => {
    mockCrypto(true)
    mockJwks()
    const del = vi.fn()
    const env = makeEnv({
      get: vi.fn().mockResolvedValue(JSON.stringify(['sid1'])),
      delete: del,
    })
    const payload = validPayload({
      events: {
        [`https://schemas.openid.net/secevent/${ns}/event-type/${eventSlug}`]: {
          hint_identifier: 'user@example.com',
        },
      },
    })
    const jwt = makeJwt(VALID_HEADER, payload)

    const response = await postRisc(jwt, env)
    const body = await response.json() as { revoked: number }

    expect(response.status).toBe(202)
    expect(body.revoked).toBe(1)
    expect(del).toHaveBeenCalledWith('session:sid1')
  })
})
