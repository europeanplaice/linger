import type { Env, Data } from '../_shared/session'
import {
  parseSessionId,
  getSession,
  getValidSession,
  saveSession,
  invalidateSession,
  addEmailSessionIndex,
  makeSessionCookie,
  SESSION_TTL,
  jsonResponse,
  validateMutationOrigin,
  RefreshTokenInvalidError,
} from '../_shared/session'

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
  } catch (err) {
    if (err instanceof RefreshTokenInvalidError) {
      // Dead refresh_token (e.g. from a retired Blue/Green OAuth client) — drop the
      // session so it stops being offered as a reuse candidate on the next sign-in.
      // Best-effort: a KV hiccup here shouldn't turn a clean 401 into a 500.
      await invalidateSession(sessionId, session.email, context.env).catch(() => {})
    }
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
    // The email index entry (esidx:{email}:{sessionId} — see session.ts) carries its
    // own TTL, separate from the session record's. Re-stamp it in step with the
    // session's own sliding renewal above, or an actively-used session would still
    // silently fall out of the index (and out of /auth/risc's reach) after the
    // *original* login's TTL, even though the session itself lives on indefinitely.
    if (validSession.email) {
      await addEmailSessionIndex(validSession.email, sessionId, context.env)
    }
  }
  const secure = !context.env.SESSION_DOMAIN.startsWith('http://')
  const newHeaders = new Headers(response.headers)
  newHeaders.append('Set-Cookie', makeSessionCookie(sessionId, SESSION_TTL, secure))
  if (context.env.CF_PAGES_COMMIT_SHA) {
    newHeaders.set('X-Deploy-Version', context.env.CF_PAGES_COMMIT_SHA)
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  })
}
