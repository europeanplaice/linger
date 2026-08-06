const GOOGLE_ISSUER = 'https://accounts.google.com'
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs'
const JWKS_CACHE_TTL_SEC = 3600

interface GoogleJwk {
  kty: string
  kid: string
  n: string
  e: string
}

export interface GoogleIdTokenClaims {
  iss: string
  aud: string | string[]
  sub: string
  email?: string
  email_verified?: boolean
  nonce?: string
  exp: number
  iat?: number
}

function base64UrlToBytes(input: string): Uint8Array<ArrayBuffer> {
  const padded = input + '='.repeat((4 - (input.length % 4)) % 4)
  const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function decodeJson<T>(input: string): T {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(input))) as T
}

async function fetchJwks(forceRefresh = false): Promise<GoogleJwk[]> {
  const request = new Request(GOOGLE_JWKS_URL)
  const cache = await caches.open('google-id-token-jwks')
  if (!forceRefresh) {
    const cached = await cache.match(request)
    if (cached) return (await cached.json() as { keys: GoogleJwk[] }).keys
  }

  const response = await fetch(GOOGLE_JWKS_URL)
  if (!response.ok) throw new Error(`Google JWKS fetch failed: ${response.status}`)
  const body = await response.json() as { keys: GoogleJwk[] }
  await cache.put(request, new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${JWKS_CACHE_TTL_SEC}` },
  }))
  return body.keys
}

export async function verifyGoogleIdToken(token: string, clientId: string, expectedNonce?: string): Promise<GoogleIdTokenClaims> {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('Malformed Google ID token')

  const [headerPart, payloadPart, signaturePart] = parts
  let header: { alg?: string; kid?: string; typ?: string }
  let claims: GoogleIdTokenClaims
  try {
    header = decodeJson(headerPart)
    claims = decodeJson(payloadPart)
  } catch {
    throw new Error('Invalid Google ID token encoding')
  }

  if (header.alg !== 'RS256' || !header.kid) throw new Error('Invalid Google ID token header')
  let keys = await fetchJwks()
  let jwk = keys.find(key => key.kid === header.kid)
  if (!jwk) {
    keys = await fetchJwks(true)
    jwk = keys.find(key => key.kid === header.kid)
  }
  if (!jwk) throw new Error('Google ID token key not found')

  const key = await crypto.subtle.importKey(
    'jwk',
    { ...jwk, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  const valid = await crypto.subtle.verify(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    base64UrlToBytes(signaturePart),
    new TextEncoder().encode(`${headerPart}.${payloadPart}`),
  )
  if (!valid) throw new Error('Google ID token signature invalid')

  const now = Math.floor(Date.now() / 1000)
  const audienceValid = Array.isArray(claims.aud) ? claims.aud.includes(clientId) : claims.aud === clientId
  if (claims.iss !== GOOGLE_ISSUER || !audienceValid) throw new Error('Google ID token issuer or audience invalid')
  if (!claims.sub || typeof claims.exp !== 'number' || claims.exp <= now) throw new Error('Google ID token expired or missing sub')
  if (claims.iat !== undefined && (typeof claims.iat !== 'number' || claims.iat > now + 60)) throw new Error('Google ID token issued in the future')
  if (expectedNonce !== undefined && claims.nonce !== expectedNonce) throw new Error('Google ID token nonce mismatch')
  if (claims.email && claims.email_verified !== true) throw new Error('Google email is not verified')

  return claims
}
