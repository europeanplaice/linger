import type { Env } from '../_shared/session'
import { deleteAllSessionsForEmail, jsonResponse } from '../_shared/session'

const GOOGLE_ISSUER = 'https://accounts.google.com'
const GOOGLE_RISC_JWKS_URL = 'https://accounts.google.com/o/oauth2/risc/jwks'

const HANDLED_EVENT_TYPES = new Set<string>([
  'https://schemas.openid.net/secevent/risc/event-type/sessions-revoked',
  'https://schemas.openid.net/secevent/risc/event-type/tokens-revoked',
  'https://schemas.openid.net/secevent/risc/event-type/account-disabled',
  'https://schemas.openid.net/secevent/risc/event-type/account-purged',
  'https://schemas.openid.net/secevent/risc/event-type/credential-compromise',
])

interface JwtHeader {
  alg: string
  kid?: string
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

async function fetchJwks(): Promise<JwkKey[]> {
  const resp = await fetch(GOOGLE_RISC_JWKS_URL)
  if (!resp.ok) throw new Error(`JWKS fetch failed: ${resp.status}`)
  const json = await resp.json() as { keys: JwkKey[] }
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

  if (header.alg !== 'RS256') throw new Error(`Unsupported alg: ${header.alg}`)
  if (!header.kid) throw new Error('Missing kid')

  const keys = await fetchJwks()
  const jwk = keys.find(k => k.kid === header.kid)
  if (!jwk) throw new Error(`No matching JWK for kid ${header.kid}`)

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

  if (claims.iss !== GOOGLE_ISSUER) throw new Error(`Invalid iss: ${claims.iss}`)

  const audValid = Array.isArray(claims.aud)
    ? claims.aud.includes(clientId)
    : claims.aud === clientId
  if (!audValid) throw new Error('Invalid aud')

  if (typeof claims.exp === 'number' && claims.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('Token expired')
  }

  if (!claims.events || typeof claims.events !== 'object') throw new Error('Missing events')

  return claims
}

function extractEmail(payload: SetEventPayload): string | null {
  if (payload.hint_identifier) return payload.hint_identifier
  if (payload.subject?.email) return payload.subject.email
  return null
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const body = (await request.text()).trim()
  if (!body) return jsonResponse({ error: 'Empty request body' }, 400)

  let claims: SetClaims
  try {
    claims = await verifyJwt(body, env.GOOGLE_CLIENT_ID)
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : 'Verification failed' }, 400)
  }

  let handled = 0
  let revoked = 0

  for (const [eventType, payload] of Object.entries(claims.events)) {
    if (!HANDLED_EVENT_TYPES.has(eventType)) continue
    handled++

    const email = extractEmail(payload)
    if (!email) {
      console.log(`RISC ${eventType}: no email available (sub=${payload?.subject?.sub ?? 'n/a'}); skipping`)
      continue
    }

    try {
      await deleteAllSessionsForEmail(email, env)
      revoked++
      console.log(`RISC ${eventType}: revoked sessions for ${email}`)
    } catch (err) {
      console.error(`RISC ${eventType}: failed to revoke sessions for ${email}: ${err instanceof Error ? err.message : err}`)
    }
  }

  return jsonResponse({ ok: true, handled, revoked }, 202)
}
