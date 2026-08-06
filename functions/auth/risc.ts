import type { Env } from '../_shared/session'
import { deleteAllSessionsForEmail, deleteAllSessionsForSub, jsonResponse } from '../_shared/session'

const GOOGLE_ISSUER = 'https://accounts.google.com'
const GOOGLE_RISC_JWKS_URL = 'https://accounts.google.com/o/oauth2/risc/jwks'

const HANDLED_EVENT_TYPES = new Set<string>([
  'https://schemas.openid.net/secevent/risc/event-type/sessions-revoked',
  'https://schemas.openid.net/secevent/oauth/event-type/tokens-revoked',  // oauth namespace, not risc
  'https://schemas.openid.net/secevent/risc/event-type/account-disabled',
  'https://schemas.openid.net/secevent/risc/event-type/account-credential-change-required',
])

const MAX_SET_AGE_SEC = 3600

interface JwtHeader {
  alg: string
  kid?: string
  typ?: string
}

interface SetEventPayload {
  subject?: {
    subject_type?: string
    iss?: string
    sub?: string
    email?: string
  }
  hint_identifier?: string
}

interface SetClaims {
  iss: string
  aud: string | string[]
  iat: number
  exp?: number
  jti?: string
  events: Record<string, SetEventPayload>
}

interface JwkKey {
  kty: string
  kid: string
  n: string
  e: string
}

function base64UrlToUint8Array(input: string): Uint8Array<ArrayBuffer> {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4))
  const base64 = (input + pad).replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function base64UrlDecodeToString(input: string): string {
  return new TextDecoder().decode(base64UrlToUint8Array(input))
}

const JWKS_CACHE_TTL_SEC = 3600

async function fetchJwks(forceRefresh = false): Promise<JwkKey[]> {
  const cacheKey = new Request(GOOGLE_RISC_JWKS_URL)
  const cache = await caches.open('risc-jwks')

  if (!forceRefresh) {
    const cached = await cache.match(cacheKey)
    if (cached) {
      const json = await cached.json() as { keys: JwkKey[] }
      return json.keys
    }
  }

  const resp = await fetch(GOOGLE_RISC_JWKS_URL)
  if (!resp.ok) throw new Error(`JWKS fetch failed: ${resp.status}`)
  const json = await resp.json() as { keys: JwkKey[] }

  await cache.put(cacheKey, new Response(JSON.stringify(json), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${JWKS_CACHE_TTL_SEC}`,
    },
  }))

  return json.keys
}

async function verifyJwt(token: string, clientId: string): Promise<SetClaims> {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('Malformed JWT')
  const [headerB64, payloadB64, signatureB64] = parts

  let header: JwtHeader
  let claims: SetClaims
  try {
    header = JSON.parse(base64UrlDecodeToString(headerB64)) as JwtHeader
    claims = JSON.parse(base64UrlDecodeToString(payloadB64)) as SetClaims
  } catch {
    throw new Error('Invalid JWT encoding')
  }

  if (header.typ?.toLowerCase() !== 'secevent+jwt') throw new Error('Invalid typ')
  if (header.alg !== 'RS256') throw new Error('Unsupported alg')
  if (!header.kid) throw new Error('Missing kid')

  let keys = await fetchJwks()
  let jwk = keys.find(k => k.kid === header.kid)
  if (!jwk) {
    // kid not in cache — Google may have rotated keys, force refresh once
    keys = await fetchJwks(true)
    jwk = keys.find(k => k.kid === header.kid)
  }
  if (!jwk) throw new Error('No matching JWK for kid')

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  )

  const valid = await crypto.subtle.verify(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    base64UrlToUint8Array(signatureB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`),
  )
  if (!valid) throw new Error('Signature verification failed')

  if (claims.iss !== GOOGLE_ISSUER) throw new Error('Invalid iss')

  const audValid = Array.isArray(claims.aud)
    ? claims.aud.includes(clientId)
    : claims.aud === clientId
  if (!audValid) throw new Error('Invalid aud')

  const nowSec = Math.floor(Date.now() / 1000)

  if (typeof claims.iat !== 'number') throw new Error('Missing iat')
  if (claims.iat > nowSec + 60) throw new Error('iat is in the future')
  if (nowSec - claims.iat > MAX_SET_AGE_SEC) throw new Error('SET is too old')

  if (typeof claims.exp === 'number' && claims.exp <= nowSec) {
    throw new Error('Token expired')
  }

  if (!claims.events || typeof claims.events !== 'object') throw new Error('Missing events')

  return claims
}

function extractEmail(payload: SetEventPayload): string | null {
  const raw = payload.subject?.email || payload.hint_identifier
  return raw ? raw.trim().toLowerCase() : null
}

function extractSub(payload: SetEventPayload): string | null {
  const sub = payload.subject?.sub?.trim()
  return sub || null
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const body = (await request.text()).trim()
  if (!body) return jsonResponse({ error: 'Empty request body' }, 400)

  let claims: SetClaims
  try {
    claims = await verifyJwt(body, env.GOOGLE_CLIENT_ID)
  } catch (err) {
    console.error('RISC SET verification failed:', err instanceof Error ? err.message : err)
    return jsonResponse({ error: 'invalid SET' }, 400)
  }

  let handled = 0
  let revoked = 0

  for (const [eventType, payload] of Object.entries(claims.events)) {
    if (!HANDLED_EVENT_TYPES.has(eventType)) continue
    handled++

    const sub = extractSub(payload)
    const email = extractEmail(payload)
    if (!sub && !email) {
      console.log(`RISC ${eventType}: no subject identifier available; skipping`)
      continue
    }

    try {
      if (sub) await deleteAllSessionsForSub(sub, env)
      // Legacy fallback for sessions created before sub indexing.
      if (email) await deleteAllSessionsForEmail(email, env)
      revoked++
      console.log(`RISC ${eventType}: revoked sessions`)
    } catch (err) {
      console.error(`RISC ${eventType}: failed to revoke sessions: ${err instanceof Error ? err.message : err}`)
    }
  }

  return jsonResponse({ ok: true, handled, revoked }, 202)
}
