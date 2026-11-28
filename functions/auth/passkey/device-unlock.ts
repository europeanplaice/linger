import { getPasskeySessionUserId } from '../../_shared/authStore'
import {
  ALLOWED_DEVICE_UNLOCK_DAYS,
  DEVICE_UNLOCK_CLOCK_SKEW_MS,
  MAX_DEVICE_UNLOCK_MS,
  clearDeviceUnlockCookie,
  makeDeviceUnlockCookie,
  parseDeviceUnlockCookie,
} from '../../_shared/deviceUnlock'
import {
  type Env,
  getSession,
  jsonResponse,
  parseSessionId,
  validateMutationOrigin,
} from '../../_shared/session'
import { encodeVaultBytes } from '../../_shared/vaultCrypto'

const DAY_SECONDS = 24 * 60 * 60
const DAY_MS = DAY_SECONDS * 1000

function isSecureCookie(env: Env): boolean {
  return !env.SESSION_DOMAIN.startsWith('http://')
}

function isAllowedFetchSite(request: Request, env: Env): boolean {
  const fetchSite = request.headers.get('Sec-Fetch-Site')
  if (!fetchSite) return true
  let isLocalDev = false
  try {
    const origin = new URL(env.SESSION_DOMAIN).origin
    isLocalDev = origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')
  } catch { /* Treat unparseable domain as non-local. */ }
  const allowed = isLocalDev ? ['same-origin', 'same-site'] : ['same-origin']
  return allowed.includes(fetchSite)
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (!isAllowedFetchSite(request, env)) {
    return jsonResponse({ error: 'Forbidden' }, 403)
  }

  const secure = isSecureCookie(env)
  const unauthorized = () => jsonResponse(
    { error: 'Unauthorized' },
    401,
    { 'Set-Cookie': clearDeviceUnlockCookie(secure) },
  )

  const sessionId = parseSessionId(request)
  const cookie = parseDeviceUnlockCookie(request)
  if (!sessionId || !cookie) return unauthorized()

  const now = Date.now()
  if (cookie.expiresAt <= now || cookie.expiresAt > now + MAX_DEVICE_UNLOCK_MS + DEVICE_UNLOCK_CLOCK_SKEW_MS) {
    return unauthorized()
  }

  try {
    if (!env.AUTH_DB) return jsonResponse({ error: 'Temporarily unavailable' }, 503)
    const sessionUserId = await getPasskeySessionUserId(sessionId, env)
    if (!sessionUserId || sessionUserId !== cookie.userId) return unauthorized()
    return jsonResponse({
      userId: sessionUserId,
      expiresAt: cookie.expiresAt,
      secret: cookie.secret,
    }, 200)
  } catch {
    return jsonResponse({ error: 'Temporarily unavailable' }, 503)
  }
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const originError = validateMutationOrigin(request, env)
  if (originError) return originError

  const sessionId = parseSessionId(request)
  const headerUserId = request.headers.get('X-Linger-Vault-User')
  const key = request.headers.get('X-Linger-Vault-Key') ?? undefined

  let session
  try {
    session = sessionId ? await getSession(sessionId, env, key) : null
  } catch {
    return jsonResponse({ error: 'Temporarily unavailable' }, 503)
  }

  if (!headerUserId || !session?.user_id || session.user_id !== headerUserId) {
    return jsonResponse({ error: 'Unauthorized' }, 401)
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonResponse({ error: 'Invalid request body' }, 400)
  }
  const days = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as { days?: unknown }).days
    : undefined
  if (days !== 1 && days !== 7) {
    return jsonResponse({ error: `Duration must be ${ALLOWED_DEVICE_UNLOCK_DAYS.join(' or ')} days` }, 400)
  }

  const secret = encodeVaultBytes(crypto.getRandomValues(new Uint8Array(32)))
  const expiresAt = Date.now() + days * DAY_MS
  const maxAge = days * DAY_SECONDS
  const secure = isSecureCookie(env)

  return jsonResponse(
    { userId: session.user_id, expiresAt, secret },
    200,
    { 'Set-Cookie': makeDeviceUnlockCookie(session.user_id, expiresAt, secret, maxAge, secure) },
  )
}

export const onRequestDelete: PagesFunction<Env> = async ({ request, env }) => {
  const originError = validateMutationOrigin(request, env)
  if (originError) return originError

  return jsonResponse(
    { ok: true },
    200,
    { 'Set-Cookie': clearDeviceUnlockCookie(isSecureCookie(env)) },
  )
}
