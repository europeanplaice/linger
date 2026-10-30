import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { verifyGoogleIdToken } from '../../functions/_shared/google'

const clientId = 'linger-client'
const now = 1_800_000_000
let keys: CryptoKeyPair
let publicJwk: JsonWebKey
let cache: Map<string, Response>
let fetchMock: ReturnType<typeof vi.fn>

function encode(value: unknown): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

async function token(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}, signingKey = keys.privateKey) {
  const payload = {
    iss: 'https://accounts.google.com', aud: clientId, sub: 'account-a',
    exp: now + 3600, iat: now, email: 'a@example.com', email_verified: true,
    nonce: 'login-nonce', ...claims,
  }
  const message = `${encode({ alg: 'RS256', kid: 'key-1', ...header })}.${encode(payload)}`
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signingKey, new TextEncoder().encode(message))
  const encodedSignature = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  return `${message}.${encodedSignature}`
}

beforeAll(async () => {
  keys = await crypto.subtle.generateKey({
    name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256',
  }, true, ['sign', 'verify']) as CryptoKeyPair
  publicJwk = await crypto.subtle.exportKey('jwk', keys.publicKey)
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(now * 1000)
  cache = new Map()
  vi.stubGlobal('caches', { open: vi.fn().mockResolvedValue({
    match: async (request: Request) => cache.get(request.url)?.clone(),
    put: async (request: Request, response: Response) => { cache.set(request.url, response.clone()) },
  }) })
  fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
    keys: [{ ...publicJwk, kid: 'key-1' }],
  })))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('Google ID token verification with real RSA signatures', () => {
  it('verifies the signature and claims of a valid login token', async () => {
    await expect(verifyGoogleIdToken(await token(), clientId, 'login-nonce')).resolves.toMatchObject({ sub: 'account-a' })
  })

  it('rejects a payload changed after signing', async () => {
    const [header, , signature] = (await token()).split('.')
    const payload = encode({ iss: 'https://accounts.google.com', aud: clientId, sub: 'account-b', exp: now + 3600 })
    await expect(verifyGoogleIdToken(`${header}.${payload}.${signature}`, clientId)).rejects.toThrow('signature invalid')
  })

  it('rejects tampered signature bytes', async () => {
    const [header, payload, signature] = (await token()).split('.')
    const tampered = `${signature.slice(0, 100)}${signature[100] === 'A' ? 'B' : 'A'}${signature.slice(101)}`
    await expect(verifyGoogleIdToken(`${header}.${payload}.${tampered}`, clientId)).rejects.toThrow('signature invalid')
  })

  it('rejects a signature made by a different private key', async () => {
    const other = await crypto.subtle.generateKey({
      name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256',
    }, true, ['sign', 'verify']) as CryptoKeyPair
    await expect(verifyGoogleIdToken(await token({}, {}, other.privateKey), clientId)).rejects.toThrow('signature invalid')
  })

  it.each([
    { iss: 'https://attacker.example' }, { aud: 'other-client' }, { aud: ['other-client'] },
    { exp: now }, { exp: now - 1 }, { exp: undefined }, { sub: '' },
    { iat: now + 61 }, { iat: 'invalid' }, { email_verified: false },
  ])('rejects invalid signed claims %j', async (claims) => {
    await expect(verifyGoogleIdToken(await token(claims), clientId)).rejects.toThrow()
  })

  it.each([{ nonce: 'another-login' }, { nonce: undefined }])('rejects a login nonce mismatch %j', async (claims) => {
    await expect(verifyGoogleIdToken(await token(claims), clientId, 'login-nonce')).rejects.toThrow('nonce mismatch')
  })

  it('accepts an audience array containing the expected client', async () => {
    await expect(verifyGoogleIdToken(await token({ aud: ['other-client', clientId] }), clientId)).resolves.toMatchObject({ sub: 'account-a' })
  })

  it.each(['', 'a.b', '!.!.!', 'e30.e30.e30'])('rejects malformed tokens %j', async (jwt) => {
    await expect(verifyGoogleIdToken(jwt, clientId)).rejects.toThrow()
  })

  it.each([{ alg: 'none' }, { alg: 'HS256' }, { kid: undefined }])('rejects an invalid token header %j', async (header) => {
    await expect(verifyGoogleIdToken(await token({}, header), clientId)).rejects.toThrow('header')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses cached keys on subsequent verification', async () => {
    const jwt = await token()
    await verifyGoogleIdToken(jwt, clientId)
    await verifyGoogleIdToken(jwt, clientId)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('refreshes cached keys for a newly rotated kid', async () => {
    await verifyGoogleIdToken(await token(), clientId)
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ keys: [{ ...publicJwk, kid: 'key-2' }] })))
    await expect(verifyGoogleIdToken(await token({}, { kid: 'key-2' }), clientId)).resolves.toMatchObject({ sub: 'account-a' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('rejects a kid absent even after refreshing keys', async () => {
    await expect(verifyGoogleIdToken(await token({}, { kid: 'missing' }), clientId)).rejects.toThrow('key not found')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('fails closed when the key endpoint is unavailable', async () => {
    fetchMock.mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
    await expect(verifyGoogleIdToken(await token(), clientId)).rejects.toThrow('JWKS fetch failed')
  })
})
