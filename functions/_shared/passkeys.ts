import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server'
import type { Env } from './session'
import { makeSessionCookie, parseSessionId, SESSION_TTL, jsonResponse } from './session'
import { createPasskeySession, getPasskeySessionInfo, getPasskeySessionUserId, sessionStorageId } from './authStore'
import { openVaultValue, sealVaultValue, validVaultKey } from './vaultCrypto'

const CHALLENGE_TTL_MS = 5 * 60 * 1000
const CHALLENGE_COOKIE = 'linger_passkey_state'
const MAX_BODY_BYTES = 128 * 1024
// This is a public, versioned PRF input shared by the app. It lets login evaluate
// PRF before the discoverable credential reveals which user's wrapper to fetch.
export const PASSKEY_PRF_INPUT = 'bGluZ2VyLXZhdWx0LWtleS12MQ'

type PasskeyEnv = Env & { AUTH_DB: D1Database }
type ChallengePurpose = 'register' | 'login' | 'add'
interface ChallengeRow { challenge: string; wrap_challenge: string; purpose: ChallengePurpose; user_id: string | null; prf_salt: string | null }
interface CredentialRow {
  credential_id: string
  user_id: string
  public_key: ArrayBuffer | Uint8Array
  counter: number
  transports: string
  prf_salt: string
  wrapped_master_key: string
}

function hasAuthDb(env: Env): env is PasskeyEnv { return !!env.AUTH_DB }

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)))
}

function passkeyAccountLabel(userId: string): { userName: string; userDisplayName: string } {
  // Distinguish separate Linger vaults in credential managers without using account data.
  const prefix = userId.slice(0, 8)
  return { userName: `Linger-${prefix}`, userDisplayName: `Linger (${prefix})` }
}

async function digest(value: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
}

function passkeyAllowedOrigins(env: Env): Set<string> {
  const configured = new URL(env.SESSION_DOMAIN)
  const allowed = new Set([configured.origin])
  if (configured.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(configured.hostname)) {
    allowed.add(`http://${configured.hostname}:5173`)
  }
  return allowed
}

function relyingParty(request: Request, env: Env): { origin: string; rpID: string } {
  const configured = new URL(env.SESSION_DOMAIN)
  // Origin is checked against this narrow allowlist before this function runs.
  // It identifies the browser's actual origin when a local Vite proxy targets
  // Pages at :8788, while the RP ID remains the configured local hostname.
  const browserOrigin = request.headers.get('Origin')
  if (!browserOrigin || !passkeyAllowedOrigins(env).has(browserOrigin)) throw new Error('Session origin does not match request')
  return { origin: browserOrigin, rpID: configured.hostname }
}

function secureCookie(env: Env): boolean { return !env.SESSION_DOMAIN.startsWith('http://') }

function parseCookie(request: Request): string | null {
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const trimmed = part.trim()
    const equals = trimmed.indexOf('=')
    if (equals < 0 || trimmed.slice(0, equals) !== CHALLENGE_COOKIE) continue
    try { return decodeURIComponent(trimmed.slice(equals + 1)) || null } catch { return null }
  }
  return null
}

function challengeCookie(value: string, env: Env): string {
  return `${CHALLENGE_COOKIE}=${encodeURIComponent(value)}; HttpOnly; SameSite=Strict; Path=/auth/passkey; Max-Age=300${secureCookie(env) ? '; Secure' : ''}`
}

function clearChallengeCookie(env: Env): string {
  return `${CHALLENGE_COOKIE}=; HttpOnly; SameSite=Strict; Path=/auth/passkey; Max-Age=0${secureCookie(env) ? '; Secure' : ''}`
}

function sameOrigin(request: Request, env: Env): Response | null {
  const origin = request.headers.get('Origin')
  let allowed: Set<string>
  try { allowed = passkeyAllowedOrigins(env) } catch { return jsonResponse({ error: 'Passkeys unavailable' }, 503) }
  if (!origin || !allowed.has(origin)) return jsonResponse({ error: 'Forbidden' }, 403)
  const fetchSite = request.headers.get('Sec-Fetch-Site')
  if (fetchSite && !['same-origin', 'same-site'].includes(fetchSite)) return jsonResponse({ error: 'Forbidden' }, 403)
  return null
}

function withChallengeCookie(response: Response, value: string, env: Env): Response {
  const headers = new Headers(response.headers)
  headers.append('Set-Cookie', challengeCookie(value, env))
  return new Response(response.body, { status: response.status, headers })
}

function withClearedChallengeCookie(response: Response, env: Env, sessionCookie?: string): Response {
  const headers = new Headers(response.headers)
  headers.append('Set-Cookie', clearChallengeCookie(env))
  if (sessionCookie) headers.append('Set-Cookie', sessionCookie)
  return new Response(response.body, { status: response.status, headers })
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const declared = Number(request.headers.get('Content-Length') ?? 0)
  if (declared > MAX_BODY_BYTES) return null
  if (!request.body) return null
  try {
    const reader = request.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_BODY_BYTES) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    const raw = new TextDecoder().decode(bytes)
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch { return null }
}

function validWrappedKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{80}={0,2}$/.test(value)) return false
  try { return atob(value).length === 60 } catch { return false }
}

function validHkdfSalt(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return false
  try { return atob(value).length === 32 } catch { return false }
}

function validWebAuthnResponse(value: unknown, requirePrf = true): value is AuthenticationResponseJSON | RegistrationResponseJSON {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  if (typeof candidate.id !== 'string' || typeof candidate.rawId !== 'string' || candidate.type !== 'public-key' ||
    !candidate.response || typeof candidate.response !== 'object' || Array.isArray(candidate.response)) return false
  if (!requirePrf) return true
  // The browser has already checked that PRF returned bytes. Those bytes never
  // cross the network; only the WebAuthn extension's non-secret enabled flag is
  // accepted here, and it is never persisted.
  const extensions = candidate.clientExtensionResults
  if (!extensions || typeof extensions !== 'object' || Array.isArray(extensions)) return false
  const prf = (extensions as Record<string, unknown>).prf
  return !!prf && typeof prf === 'object' && !Array.isArray(prf) && (prf as Record<string, unknown>).enabled === true
}

async function beginChallenge(
  env: PasskeyEnv,
  purpose: ChallengePurpose,
  userId: string | null,
  prfSalt: string | null,
  challenge: string,
  wrapChallenge: string,
): Promise<string> {
  await env.AUTH_DB.prepare('DELETE FROM passkey_challenges WHERE id IN (SELECT id FROM passkey_challenges WHERE expires_at <= ? LIMIT 100)')
    .bind(Date.now()).run()
  const cookie = randomToken()
  const id = await digest(cookie)
  await env.AUTH_DB.prepare('INSERT INTO passkey_challenges (id, challenge, wrap_challenge, purpose, user_id, prf_salt, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, challenge, wrapChallenge, purpose, userId, prfSalt, Date.now() + CHALLENGE_TTL_MS).run()
  return cookie
}

async function consumeChallenge(request: Request, env: PasskeyEnv, purpose: ChallengePurpose): Promise<ChallengeRow | null> {
  const cookie = parseCookie(request)
  if (!cookie || cookie.length > 100) return null
  const row = await env.AUTH_DB.prepare(`DELETE FROM passkey_challenges WHERE id = ? AND purpose = ? AND expires_at > ? RETURNING challenge, wrap_challenge, purpose, user_id, prf_salt`)
    .bind(await digest(cookie), purpose, Date.now()).first<ChallengeRow>()
  return row ?? null
}

function userIdBytes(userId: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(new TextEncoder().encode(userId))
}

function transportList(value: unknown): string {
  if (!Array.isArray(value)) return '[]'
  const allowed = value.filter((item): item is string => typeof item === 'string' && ['ble', 'hybrid', 'internal', 'nfc', 'usb'].includes(item))
  return JSON.stringify([...new Set(allowed)])
}

function credentialId(response: AuthenticationResponseJSON | RegistrationResponseJSON): string {
  return response.id
}

function publicKeyBytes(value: Uint8Array): ArrayBuffer {
  return Uint8Array.from(value).buffer
}

async function authenticatedUser(request: Request, env: PasskeyEnv): Promise<string | null> {
  const sessionId = parseSessionId(request)
  return sessionId ? getPasskeySessionUserId(sessionId, env) : null
}

async function validateUnlockedProfile(request: Request, env: PasskeyEnv, userId: string): Promise<boolean> {
  const key = request.headers.get('X-Linger-Vault-Key')
  if (request.headers.get('X-Linger-Vault-User') !== userId || !validVaultKey(key)) return false
  const row = await env.AUTH_DB.prepare('SELECT account_envelope FROM passkey_users WHERE id = ?').bind(userId).first<{ account_envelope: string | null }>()
  if (!row?.account_envelope) return false
  try {
    await openVaultValue<unknown>(key, userId, 'account-metadata', row.account_envelope)
    return true
  } catch { return false }
}

export async function registrationOptions(request: Request, env: Env): Promise<Response> {
  const rejected = sameOrigin(request, env)
  if (rejected) return rejected
  if (!hasAuthDb(env)) return jsonResponse({ error: 'Passkeys unavailable' }, 503)
  try {
    const { rpID } = relyingParty(request, env)
    const userId = crypto.randomUUID()
    const accountLabel = passkeyAccountLabel(userId)
    const prfSalt = base64(crypto.getRandomValues(new Uint8Array(32)))
    const options = await generateRegistrationOptions({
      rpName: 'Linger', rpID, userID: userIdBytes(userId),
      ...accountLabel,
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      extensions: { prf: { eval: { first: fromBase64url(PASSKEY_PRF_INPUT) } } },
    })
    const wrapOptions = await generateAuthenticationOptions({
      rpID, userVerification: 'required', allowCredentials: [],
      extensions: { prf: { eval: { first: fromBase64url(PASSKEY_PRF_INPUT) } } },
    })
    const cookie = await beginChallenge(env, 'register', userId, prfSalt, options.challenge, wrapOptions.challenge)
    return withChallengeCookie(jsonResponse({ options, wrapOptions, userId, prfInput: PASSKEY_PRF_INPUT, prfSalt }), cookie, env)
  } catch { return jsonResponse({ error: 'Passkey setup failed' }, 500) }
}

export async function registrationVerify(request: Request, env: Env): Promise<Response> {
  const rejected = sameOrigin(request, env)
  if (rejected) return rejected
  if (!hasAuthDb(env)) return jsonResponse({ error: 'Passkeys unavailable' }, 503)
  const body = await readJson(request)
  if (!body || !validWebAuthnResponse(body.response) || !validWebAuthnResponse(body.assertion) ||
    !validWrappedKey(body.wrappedMasterKey) || !validHkdfSalt(body.prfSalt)) {
    return withClearedChallengeCookie(jsonResponse({ error: 'Invalid passkey response' }, 400), env)
  }
  const challenge = await consumeChallenge(request, env, 'register')
  if (!challenge?.user_id || !challenge.prf_salt || challenge.prf_salt !== body.prfSalt) return withClearedChallengeCookie(jsonResponse({ error: 'Challenge expired' }, 400), env)
  const vaultKey = request.headers.get('X-Linger-Vault-Key')
  if (request.headers.get('X-Linger-Vault-User') !== challenge.user_id || !validVaultKey(vaultKey)) {
    return withClearedChallengeCookie(jsonResponse({ error: 'Invalid passkey setup' }, 400), env)
  }
  try {
    const { origin, rpID } = relyingParty(request, env)
    const verification = await verifyRegistrationResponse({
      response: body.response as RegistrationResponseJSON,
      expectedChallenge: challenge.challenge, expectedOrigin: origin, expectedRPID: rpID,
      requireUserVerification: true,
    })
    if (!verification.verified || !verification.registrationInfo) throw new Error('Not verified')
    const credential = verification.registrationInfo.credential
    const credentialIdValue = credential.id
    const credentialPublicKey = publicKeyBytes(credential.publicKey)
    const assertion = body.assertion as AuthenticationResponseJSON
    if (assertion.id !== credentialIdValue || (assertion.response.userHandle != null && assertion.response.userHandle !== base64url(new TextEncoder().encode(challenge.user_id)))) throw new Error('New credential assertion mismatch')
    const assertionVerification = await verifyAuthenticationResponse({
      response: assertion, expectedChallenge: challenge.wrap_challenge,
      expectedOrigin: origin, expectedRPID: rpID,
      credential: { id: credentialIdValue, publicKey: credential.publicKey, counter: credential.counter,
        transports: credential.transports },
      requireUserVerification: true,
    })
    if (!assertionVerification.verified) throw new Error('PRF assertion failed')
    const count = assertionVerification.authenticationInfo.newCounter
    const transports = transportList((body.response as RegistrationResponseJSON).response.transports)
    const now = Date.now()
    const initialProfile = await sealVaultValue(vaultKey, challenge.user_id, 'account-metadata', {})
    await env.AUTH_DB.batch([
      env.AUTH_DB.prepare('INSERT INTO passkey_users (id, account_envelope, revision, created_at) VALUES (?, ?, 0, ?)').bind(challenge.user_id, initialProfile, now),
      env.AUTH_DB.prepare('INSERT INTO passkey_credentials (credential_id, user_id, public_key, counter, transports, prf_salt, wrapped_master_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(credentialIdValue, challenge.user_id, credentialPublicKey, count, transports, challenge.prf_salt, body.wrappedMasterKey, now),
    ])
    const sessionId = randomToken(32)
    await createPasskeySession(sessionId, challenge.user_id, env, credentialIdValue)
    return withClearedChallengeCookie(jsonResponse({ userId: challenge.user_id, wrappedMasterKey: body.wrappedMasterKey, prfSalt: challenge.prf_salt }), env,
      makeSessionCookie(sessionId, SESSION_TTL, secureCookie(env)))
  } catch {
    return withClearedChallengeCookie(jsonResponse({ error: 'Passkey setup failed' }, 400), env)
  }
}

export async function loginOptions(request: Request, env: Env): Promise<Response> {
  const rejected = sameOrigin(request, env)
  if (rejected) return rejected
  if (!hasAuthDb(env)) return jsonResponse({ error: 'Passkeys unavailable' }, 503)
  try {
    const { rpID } = relyingParty(request, env)
    const options = await generateAuthenticationOptions({
      rpID, userVerification: 'required', allowCredentials: [],
      extensions: { prf: { eval: { first: fromBase64url(PASSKEY_PRF_INPUT) } } },
    })
    const cookie = await beginChallenge(env, 'login', null, null, options.challenge, options.challenge)
    return withChallengeCookie(jsonResponse({ options, prfInput: PASSKEY_PRF_INPUT }), cookie, env)
  } catch { return jsonResponse({ error: 'Passkey login failed' }, 500) }
}

export async function loginVerify(request: Request, env: Env): Promise<Response> {
  const rejected = sameOrigin(request, env)
  if (rejected) return rejected
  if (!hasAuthDb(env)) return jsonResponse({ error: 'Passkeys unavailable' }, 503)
  const body = await readJson(request)
  const managementAction = body?.managementAction === 'add' || body?.managementAction === 'delete'
  if (!body || !validWebAuthnResponse(body.response, !managementAction)) return withClearedChallengeCookie(jsonResponse({ error: 'Invalid passkey response' }, 400), env)
  const challenge = await consumeChallenge(request, env, 'login')
  if (!challenge) return withClearedChallengeCookie(jsonResponse({ error: 'Challenge expired' }, 400), env)
  const response = body.response as AuthenticationResponseJSON
  try {
    const row = await env.AUTH_DB.prepare('SELECT credential_id, user_id, public_key, counter, transports, prf_salt, wrapped_master_key FROM passkey_credentials WHERE credential_id = ?')
      .bind(credentialId(response)).first<CredentialRow>()
    if (!row) throw new Error('Unknown credential')
    const expectedUserHandle = base64url(new TextEncoder().encode(row.user_id))
    if (!response.response.userHandle || response.response.userHandle !== expectedUserHandle) throw new Error('Credential user handle mismatch')
    const { origin, rpID } = relyingParty(request, env)
    const result = await verifyAuthenticationResponse({
      response, expectedChallenge: challenge.challenge, expectedOrigin: origin, expectedRPID: rpID,
      credential: { id: row.credential_id, publicKey: new Uint8Array(row.public_key), counter: row.counter,
        transports: JSON.parse(row.transports) as AuthenticatorTransport[] },
      requireUserVerification: true,
    })
    if (!result.verified) throw new Error('Not verified')
    const nextCounter = result.authenticationInfo.newCounter
    if (row.counter > 0 && nextCounter <= row.counter) throw new Error('Authenticator counter did not advance')
    const update = await env.AUTH_DB.prepare('UPDATE passkey_credentials SET counter = ? WHERE credential_id = ? AND counter = ?')
      .bind(nextCounter, row.credential_id, row.counter).run()
    if (!update.success || update.meta.changes !== 1) throw new Error('Credential changed concurrently')
    if (body.managementAction === 'add' || body.managementAction === 'delete') {
      const currentId = parseSessionId(request)
      const current = currentId ? await getPasskeySessionInfo(currentId, env) : null
      if (!current || current.userId !== row.user_id || request.headers.get('X-Linger-Vault-User') !== row.user_id ||
          !await validateUnlockedProfile(request, env, row.user_id)) throw new Error('Account mismatch')
      await env.AUTH_DB.prepare('DELETE FROM passkey_management_grants WHERE session_id IN (SELECT session_id FROM passkey_management_grants WHERE expires_at <= ? LIMIT 100)').bind(Date.now()).run()
      await env.AUTH_DB.prepare('INSERT INTO passkey_management_grants (session_id, action, expires_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET action = excluded.action, expires_at = excluded.expires_at')
        .bind(await sessionStorageId(currentId!), body.managementAction, Date.now() + 60_000).run()
      return withClearedChallengeCookie(jsonResponse({ ok: true }), env)
    }
    const sessionId = randomToken(32)
    await createPasskeySession(sessionId, row.user_id, env, row.credential_id)
    return withClearedChallengeCookie(jsonResponse({
      userId: row.user_id,
      credentialId: row.credential_id,
      wrapper: { wrappedMasterKey: row.wrapped_master_key, prfSalt: row.prf_salt },
    }), env, makeSessionCookie(sessionId, SESSION_TTL, secureCookie(env)))
  } catch { return withClearedChallengeCookie(jsonResponse({ error: 'Passkey verification failed' }, 401), env) }
}

export async function addOptions(request: Request, env: Env): Promise<Response> {
  const rejected = sameOrigin(request, env)
  if (rejected) return rejected
  if (!hasAuthDb(env)) return jsonResponse({ error: 'Passkeys unavailable' }, 503)
  const userId = await authenticatedUser(request, env)
  if (!userId) return jsonResponse({ error: 'Unauthorized' }, 401)
  const sessionId = parseSessionId(request)
  const grant = sessionId && await env.AUTH_DB.prepare("DELETE FROM passkey_management_grants WHERE session_id = ? AND action = 'add' AND expires_at > ? RETURNING session_id")
    .bind(await sessionStorageId(sessionId), Date.now()).first()
  if (!grant) return jsonResponse({ error: 'Passkey verification required' }, 401)
  try {
    if (!await validateUnlockedProfile(request, env, userId)) return jsonResponse({ error: 'Vault unlock required' }, 401)
    const { rpID } = relyingParty(request, env)
    const accountLabel = passkeyAccountLabel(userId)
    const prfSalt = base64(crypto.getRandomValues(new Uint8Array(32)))
    const existing = await env.AUTH_DB.prepare('SELECT credential_id FROM passkey_credentials WHERE user_id = ?').bind(userId).all<{ credential_id: string }>()
    const options = await generateRegistrationOptions({
      rpName: 'Linger', rpID, userID: userIdBytes(userId), ...accountLabel,
      attestationType: 'none', excludeCredentials: (existing.results ?? []).map(item => ({ id: item.credential_id })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      extensions: { prf: { eval: { first: fromBase64url(PASSKEY_PRF_INPUT) } } },
    })
    const wrapOptions = await generateAuthenticationOptions({
      rpID, userVerification: 'required', allowCredentials: [],
      extensions: { prf: { eval: { first: fromBase64url(PASSKEY_PRF_INPUT) } } },
    })
    const cookie = await beginChallenge(env, 'add', userId, prfSalt, options.challenge, wrapOptions.challenge)
    return withChallengeCookie(jsonResponse({ options, wrapOptions, userId, prfInput: PASSKEY_PRF_INPUT, prfSalt }), cookie, env)
  } catch { return jsonResponse({ error: 'Passkey setup failed' }, 500) }
}

export async function addVerify(request: Request, env: Env): Promise<Response> {
  const rejected = sameOrigin(request, env)
  if (rejected) return rejected
  if (!hasAuthDb(env)) return jsonResponse({ error: 'Passkeys unavailable' }, 503)
  const browserSessionId = parseSessionId(request)
  const browserSession = browserSessionId ? await getPasskeySessionInfo(browserSessionId, env) : null
  const userId = browserSession?.userId
  if (!userId) return withClearedChallengeCookie(jsonResponse({ error: 'Unauthorized' }, 401), env)
  if (!await validateUnlockedProfile(request, env, userId)) return withClearedChallengeCookie(jsonResponse({ error: 'Vault unlock required' }, 401), env)
  const body = await readJson(request)
  if (!body || !validWebAuthnResponse(body.response) || !validWebAuthnResponse(body.assertion) ||
    !validWrappedKey(body.wrappedMasterKey) || !validHkdfSalt(body.prfSalt)) return withClearedChallengeCookie(jsonResponse({ error: 'Invalid passkey response' }, 400), env)
  const challenge = await consumeChallenge(request, env, 'add')
  if (!challenge?.user_id || challenge.user_id !== userId || !challenge.prf_salt || challenge.prf_salt !== body.prfSalt) return withClearedChallengeCookie(jsonResponse({ error: 'Challenge expired' }, 400), env)
  try {
    const { origin, rpID } = relyingParty(request, env)
    const result = await verifyRegistrationResponse({
      response: body.response as RegistrationResponseJSON,
      expectedChallenge: challenge.challenge, expectedOrigin: origin, expectedRPID: rpID,
      requireUserVerification: true,
    })
    if (!result.verified || !result.registrationInfo) throw new Error('Not verified')
    const credential = result.registrationInfo.credential
    const assertion = body.assertion as AuthenticationResponseJSON
    if (assertion.id !== credential.id || (assertion.response.userHandle != null && assertion.response.userHandle !== base64url(new TextEncoder().encode(userId)))) throw new Error('New credential assertion mismatch')
    const assertionVerification = await verifyAuthenticationResponse({
      response: assertion, expectedChallenge: challenge.wrap_challenge,
      expectedOrigin: origin, expectedRPID: rpID,
      credential: { id: credential.id, publicKey: credential.publicKey, counter: credential.counter,
        transports: credential.transports },
      requireUserVerification: true,
    })
    if (!assertionVerification.verified) throw new Error('PRF assertion failed')
    const inserted = await env.AUTH_DB.prepare(`INSERT INTO passkey_credentials
      (credential_id, user_id, public_key, counter, transports, prf_salt, wrapped_master_key, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (
        SELECT 1 FROM auth_sessions s WHERE s.id = ? AND s.user_id = ? AND s.revoked = 0 AND s.expires_at > ?
          AND (s.credential_id IS NULL OR EXISTS (
            SELECT 1 FROM passkey_credentials c WHERE c.credential_id = s.credential_id AND c.user_id = s.user_id
          ))
      )`)
      .bind(credential.id, userId, publicKeyBytes(credential.publicKey), assertionVerification.authenticationInfo.newCounter,
        transportList((body.response as RegistrationResponseJSON).response.transports), challenge.prf_salt, body.wrappedMasterKey, Date.now(),
        await sessionStorageId(browserSessionId!), userId, Date.now()).run()
    if (!inserted.success || inserted.meta.changes !== 1) throw new Error('Passkey session ended')
    return withClearedChallengeCookie(jsonResponse({ ok: true, userId }), env)
  } catch { return withClearedChallengeCookie(jsonResponse({ error: 'Passkey setup failed' }, 400), env) }
}

export async function listCredentials(request: Request, env: Env): Promise<Response> {
  const rejected = sameOrigin(request, env)
  if (rejected) return rejected
  if (!hasAuthDb(env)) return jsonResponse({ error: 'Passkeys unavailable' }, 503)
  const sessionId = parseSessionId(request)
  const session = sessionId ? await getPasskeySessionInfo(sessionId, env) : null
  if (!session) return jsonResponse({ error: 'Unauthorized' }, 401)
  if (request.headers.get('X-Linger-Vault-User') !== session.userId || !await validateUnlockedProfile(request, env, session.userId)) {
    return jsonResponse({ error: 'Vault unlock required' }, 401)
  }
  const result = await env.AUTH_DB.prepare('SELECT credential_id, created_at FROM passkey_credentials WHERE user_id = ? ORDER BY created_at, credential_id')
    .bind(session.userId).all<{ credential_id: string; created_at: number }>()
  return jsonResponse({
    credentials: (result.results ?? []).map(row => ({ credentialId: row.credential_id, createdAt: row.created_at })),
    currentCredentialId: session.credentialId,
  })
}

export async function deleteCredential(request: Request, env: Env): Promise<Response> {
  const rejected = sameOrigin(request, env)
  if (rejected) return rejected
  if (!hasAuthDb(env)) return jsonResponse({ error: 'Passkeys unavailable' }, 503)
  const sessionId = parseSessionId(request)
  const session = sessionId ? await getPasskeySessionInfo(sessionId, env) : null
  if (!session) return jsonResponse({ error: 'Unauthorized' }, 401)
  if (request.headers.get('X-Linger-Vault-User') !== session.userId || !await validateUnlockedProfile(request, env, session.userId)) {
    return jsonResponse({ error: 'Vault unlock required' }, 401)
  }
  const body = await readJson(request)
  if (!body || typeof body.credentialId !== 'string' || !body.credentialId || body.credentialId.length > 1024) {
    return jsonResponse({ error: 'Invalid credential' }, 400)
  }
  if (body.credentialId === session.credentialId) return jsonResponse({ error: 'Current credential cannot be deleted' }, 409)
  const grant = await env.AUTH_DB.prepare("DELETE FROM passkey_management_grants WHERE session_id = ? AND action = 'delete' AND expires_at > ? RETURNING session_id")
    .bind(await sessionStorageId(sessionId!), Date.now()).first()
  if (!grant) return jsonResponse({ error: 'Passkey verification required' }, 401)
  // D1 batch executes these statements as one transaction. The guarded DELETE
  // makes the final-credential check atomic with removal, including concurrent deletes.
  const deletion = env.AUTH_DB.prepare(`DELETE FROM passkey_credentials
    WHERE credential_id = ? AND user_id = ? AND (SELECT COUNT(*) FROM passkey_credentials WHERE user_id = ?) > 1
      AND EXISTS (
        SELECT 1 FROM auth_sessions s WHERE s.id = ? AND s.user_id = ? AND s.revoked = 0 AND s.expires_at > ?
          AND (s.credential_id IS NULL OR EXISTS (
            SELECT 1 FROM passkey_credentials current_c WHERE current_c.credential_id = s.credential_id AND current_c.user_id = s.user_id
          ))
      ) RETURNING credential_id`).bind(body.credentialId, session.userId, session.userId,
        await sessionStorageId(sessionId!), session.userId, Date.now())
  const revocation = env.AUTH_DB.prepare(`UPDATE auth_sessions SET user_id = NULL, credential_id = NULL, revoked = 1, data = NULL
    WHERE credential_id = ? AND user_id = ? AND NOT EXISTS (
      SELECT 1 FROM passkey_credentials c WHERE c.credential_id = ? AND c.user_id = ?
    )`)
    .bind(body.credentialId, session.userId, body.credentialId, session.userId)
  const [deleted] = await env.AUTH_DB.batch([deletion, revocation]) as [{ results?: Array<{ credential_id: string }> }, unknown]
  if (!deleted?.results?.length) {
    if (!await getPasskeySessionInfo(sessionId!, env)) return jsonResponse({ error: 'Unauthorized' }, 401)
    const existing = await env.AUTH_DB.prepare('SELECT credential_id FROM passkey_credentials WHERE credential_id = ? AND user_id = ?')
      .bind(body.credentialId, session.userId).first<{ credential_id: string }>()
    return existing ? jsonResponse({ error: 'Last credential cannot be deleted' }, 409) : jsonResponse({ error: 'Credential not found' }, 404)
  }
  return jsonResponse({ ok: true })
}

function fromBase64url(input: string): Uint8Array {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - input.length % 4) % 4)
  const binary = atob(base64)
  return Uint8Array.from(binary, char => char.charCodeAt(0))
}
