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

const VALID_HEADER = { alg: 'RS256', kid: 'key-1' }

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

function mockJwks() {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
    new Response(JSON.stringify(FAKE_JWKS), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  ))
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
    const body = await response.json() as { error: string }
    expect(body.error).toContain('Malformed JWT')
  })

  it('returns 400 when alg is not RS256', async () => {
    const jwt = makeJwt({ alg: 'HS256', kid: 'key-1' }, validPayload())
    const response = await postRisc(jwt, makeEnv())
    expect(response.status).toBe(400)
    const body = await response.json() as { error: string }
    expect(body.error).toContain('Unsupported alg')
  })

  it('returns 400 when kid is missing from header', async () => {
    const jwt = makeJwt({ alg: 'RS256' }, validPayload())
    const response = await postRisc(jwt, makeEnv())
    expect(response.status).toBe(400)
    const body = await response.json() as { error: string }
    expect(body.error).toContain('Missing kid')
  })

  it('returns 400 when JWKS fetch fails', async () => {
    mockCrypto(true)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('error', { status: 500 })))
    const jwt = makeJwt(VALID_HEADER, validPayload())
    const response = await postRisc(jwt, makeEnv())
    expect(response.status).toBe(400)
    const body = await response.json() as { error: string }
    expect(body.error).toContain('JWKS fetch failed')
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
    const body = await response.json() as { error: string }
    expect(body.error).toContain('No matching JWK')
  })

  it('returns 400 when signature verification fails', async () => {
    mockCrypto(false)
    mockJwks()
    const jwt = makeJwt(VALID_HEADER, validPayload())
    const response = await postRisc(jwt, makeEnv())
    expect(response.status).toBe(400)
    const body = await response.json() as { error: string }
    expect(body.error).toContain('Signature verification failed')
  })

  it('returns 400 when iss does not match Google', async () => {
    mockCrypto(true)
    mockJwks()
    const jwt = makeJwt(VALID_HEADER, validPayload({ iss: 'https://evil.com' }))
    const response = await postRisc(jwt, makeEnv())
    expect(response.status).toBe(400)
    const body = await response.json() as { error: string }
    expect(body.error).toContain('Invalid iss')
  })

  it('returns 400 when aud does not match client ID', async () => {
    mockCrypto(true)
    mockJwks()
    const jwt = makeJwt(VALID_HEADER, validPayload({ aud: 'wrong-client' }))
    const response = await postRisc(jwt, makeEnv())
    expect(response.status).toBe(400)
    const body = await response.json() as { error: string }
    expect(body.error).toContain('Invalid aud')
  })

  it('returns 400 when token is expired', async () => {
    mockCrypto(true)
    mockJwks()
    const jwt = makeJwt(VALID_HEADER, validPayload({ exp: Math.floor(Date.now() / 1000) - 1 }))
    const response = await postRisc(jwt, makeEnv())
    expect(response.status).toBe(400)
    const body = await response.json() as { error: string }
    expect(body.error).toContain('Token expired')
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
    'sessions-revoked',
    'tokens-revoked',
    'account-disabled',
    'account-purged',
    'credential-compromise',
  ])('revokes sessions for RISC event type: %s', async (eventSlug) => {
    mockCrypto(true)
    mockJwks()
    const del = vi.fn()
    const env = makeEnv({
      get: vi.fn().mockResolvedValue(JSON.stringify(['sid1'])),
      delete: del,
    })
    const payload = validPayload({
      events: {
        [`https://schemas.openid.net/secevent/risc/event-type/${eventSlug}`]: {
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
