import type { Env, Data } from '../_shared/session'
import {
  parseSessionId,
  getSession,
  getValidSession,
  saveSession,
  makeSessionCookie,
  SESSION_TTL,
  jsonResponse,
  validateMutationOrigin,
} from '../_shared/session'

// Injected at deploy time via wrangler pages deploy --var; absent in local dev.
declare const DEPLOY_VERSION: string | undefined

// KV writes are capped at 1000/day on the free tier. Writing on every request
// would exhaust the quota quickly, so we throttle TTL renewal to once per day.
// Only bypass this when the token itself changed (tokenRefreshed).
const RENEW_INTERVAL = 60 * 60 * 24 * 1000 // 24 hours

export const onRequest: PagesFunction<Env, string, Data> = async (context) => {
  const originError = validateMutationOrigin(context.request, context.env)
  if (originError) return originError

  const sessionId = parseSessionId(context.request)
  if (!sessionId) return jsonResponse({ error: 'Unauthorized' }, 401)

  const session = await getSession(sessionId, context.env)
  if (!session) return jsonResponse({ error: 'Session not found' }, 401)

  let validSession = session
  try {
    validSession = await getValidSession(sessionId, session, context.env)
  } catch {
    return jsonResponse({ error: 'Token refresh failed' }, 401)
  }

  context.data.sessionId = sessionId
  context.data.accessToken = validSession.access_token
  context.data.session = validSession

  const response = await context.next()

  const tokenRefreshed = validSession !== session
  const needsRenew = !validSession.renewed_at || Date.now() - validSession.renewed_at > RENEW_INTERVAL
  if (tokenRefreshed || needsRenew) {
    await saveSession(sessionId, { ...validSession, renewed_at: Date.now() }, context.env)
  }
  const secure = !context.env.SESSION_DOMAIN.startsWith('http://')
  const newHeaders = new Headers(response.headers)
  newHeaders.append('Set-Cookie', makeSessionCookie(sessionId, SESSION_TTL, secure))
  if (typeof DEPLOY_VERSION !== 'undefined' && DEPLOY_VERSION) {
    newHeaders.set('X-Deploy-Version', DEPLOY_VERSION)
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  })
}
