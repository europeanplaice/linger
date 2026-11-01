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

export interface GoogleAccessTokenInfo {
  aud?: string | string[]
  azp?: string
  sub?: string
  exp?: string | number
  issued_to?: string
  audience?: string
  user_id?: string
  scope?: string
  expires_in?: string | number
}

export class GoogleAccessTokenValidationError extends Error {
  constructor(message: string, readonly transient: boolean) { super(message) }
}
export class GoogleIdTokenValidationError extends Error {
  constructor(message: string, readonly transient: boolean) { super(message) }
}

// Access tokens are opaque. Ask Google's tokeninfo endpoint over POST (never put
// the credential in a URL) and bind it to this OAuth client, user, scope, and expiry.
export async function verifyGoogleAccessToken(token: string, clientId: string, expectedSub: string): Promise<number> {
  let response: Response
  try {
    response = await fetch('https://oauth2.googleapis.com/tokeninfo', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new GoogleAccessTokenValidationError('Google access token validation unavailable', true)
  }
  if (!response.ok) throw new GoogleAccessTokenValidationError(`Google access token validation failed: ${response.status}`, response.status === 429 || response.status >= 500)
  let info: GoogleAccessTokenInfo
  try { info = await response.json() as GoogleAccessTokenInfo }
  catch { throw new GoogleAccessTokenValidationError('Google access token validation unavailable', true) }
  const scopes = new Set((info.scope ?? '').split(/\s+/).filter(Boolean))
  const audiences = Array.isArray(info.aud) ? info.aud : info.aud ? [info.aud] : []
  const tokenClient = audiences.includes(clientId) || info.azp === clientId || info.issued_to === clientId || info.audience === clientId
  const tokenSub = info.sub ?? info.user_id
  if (!tokenClient || tokenSub !== expectedSub || !scopes.has('https://www.googleapis.com/auth/drive.file')) {
    throw new GoogleAccessTokenValidationError('Google access token client, account, or scope mismatch', false)
  }
  const expiresIn = Number(info.expires_in ?? (info.exp ? Number(info.exp) - Math.floor(Date.now() / 1000) : 0))
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw new GoogleAccessTokenValidationError('Google access token expired', false)
  return expiresIn
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
  try {
    const request = new Request(GOOGLE_JWKS_URL)
    const cache = await caches.open('google-id-token-jwks')
    if (!forceRefresh) {
      const cached = await cache.match(request)
      if (cached) return (await cached.json() as { keys: GoogleJwk[] }).keys
    }

    const response = await fetch(GOOGLE_JWKS_URL)
    if (!response.ok) throw new GoogleIdTokenValidationError(`Google JWKS fetch failed: ${response.status}`, response.status === 429 || response.status >= 500)
    const body = await response.json() as { keys: GoogleJwk[] }
    try {
      await cache.put(request, new Response(JSON.stringify(body), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${JWKS_CACHE_TTL_SEC}` },
      }))
    } catch { /* A cache write failure must not reject a verified identity token. */ }
    return body.keys
  } catch (error) {
    if (error instanceof GoogleIdTokenValidationError) throw error
    throw new GoogleIdTokenValidationError('Google identity validation unavailable', true)
  }
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
