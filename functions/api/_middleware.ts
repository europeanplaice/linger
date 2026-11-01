import type { Env, Data } from '../_shared/session'
import {
  parseSessionId,
  getSession,
  saveSession,
  makeSessionCookie,
  clearSessionCookie,
  isSessionRevoked,
  SessionRevokedError,
  SESSION_TTL,
  jsonResponse,
  validateMutationOrigin,
  validateRequestAccount,
} from '../_shared/session'
import { GoogleAccessTokenValidationError, GoogleIdTokenValidationError, verifyGoogleAccessToken, verifyGoogleIdToken } from '../_shared/google'

const RENEW_INTERVAL = 60 * 60 * 24 * 1000

function bearerToken(request: Request): string | null {
  const value = request.headers.get('Authorization') ?? ''
  const match = /^Bearer\s+([^\s]+)$/i.exec(value)
  return match?.[1] ?? null
}

export const onRequest: PagesFunction<Env, string, Data> = async (context) => {
  const originError = validateMutationOrigin(context.request, context.env)
  if (originError) return originError

  const sessionId = parseSessionId(context.request)
  if (!sessionId) return jsonResponse({ error: 'Unauthorized' }, 401)
  const session = await getSession(sessionId, context.env)
  if (!session || !session.google_sub) return jsonResponse({ error: 'Session not found' }, 401)
  const accountError = validateRequestAccount(context.request, session)
  if (accountError) return accountError

  const accessToken = bearerToken(context.request)
  if (!accessToken) return jsonResponse({ error: 'Google authorization required' }, 401)
  let expiresIn: number
  try {
    expiresIn = await verifyGoogleAccessToken(accessToken, context.env.GOOGLE_CLIENT_ID, session.google_sub)
  } catch (error) {
    if (error instanceof GoogleAccessTokenValidationError && error.transient) {
      return jsonResponse({ error: 'Google authorization temporarily unavailable' }, 503, { 'Retry-After': '1' })
    }
    if (error instanceof GoogleAccessTokenValidationError) return jsonResponse({ error: 'Google authorization expired or invalid' }, 401)
    return jsonResponse({ error: 'Google authorization temporarily unavailable' }, 503, { 'Retry-After': '1' })
  }

  const idToken = context.request.headers.get('X-Linger-Google-ID-Token') ?? undefined
  if (idToken) {
    try {
      const claims = await verifyGoogleIdToken(idToken, context.env.GOOGLE_CLIENT_ID)
      if (claims.sub !== session.google_sub) return jsonResponse({ error: 'Google account changed' }, 401)
      session.id_token = idToken
      session.id_token_verified = true
    } catch (error) {
      if (error instanceof GoogleIdTokenValidationError && error.transient) {
        return jsonResponse({ error: 'Google identity validation temporarily unavailable' }, 503, { 'Retry-After': '1' })
      }
      return jsonResponse({ error: 'Google identity token expired or invalid' }, 401)
    }
  }

  // Credentials live only on this request's context object. saveSession below
  // projects to a strict metadata allowlist before writing D1 or KV.
  session.access_token = accessToken
  session.expires_at = Date.now() + expiresIn * 1000
  context.data.sessionId = sessionId
  context.data.accessToken = accessToken
  context.data.idToken = idToken
  context.data.session = session

  const response = await context.next()
  const secure = !context.env.SESSION_DOMAIN.startsWith('http://')
  const revokedResponse = () => jsonResponse({ error: 'Session revoked' }, 401, {
    'Set-Cookie': clearSessionCookie(secure),
  })
  if (await isSessionRevoked(sessionId, context.env)) return revokedResponse()

  if (!session.renewed_at || Date.now() - session.renewed_at > RENEW_INTERVAL) {
    try {
      session.renewed_at = Date.now()
      await saveSession(sessionId, session, context.env)
    } catch (error) {
      if (error instanceof SessionRevokedError) return revokedResponse()
      throw error
    }
  }

  const headers = new Headers(response.headers)
  headers.append('Set-Cookie', makeSessionCookie(sessionId, SESSION_TTL, secure))
  if (context.env.CF_PAGES_COMMIT_SHA) headers.set('X-Deploy-Version', context.env.CF_PAGES_COMMIT_SHA)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
