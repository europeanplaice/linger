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
// A token refresh (roughly hourly) is persisted separately by getValidSession
// itself and doesn't bypass this throttle.
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
      return jsonResponse({ error: 'Token refresh failed' }, 401)
    }
    // Transient refresh failure (network blip between this Worker and Google's
    // token endpoint, or a 429/5xx from Google that outlasted the in-function
    // retries) — the session itself is fine, only the refresh didn't land. A 401
    // here would make the client tear down the whole session-expired flow
    // (modal + forced re-login) for a session that never died, and the refresh
    // would just succeed moments later. A 503 instead lets the client's existing
    // retry-with-backoff handle it and self-heal once Google recovers.
    return jsonResponse({ error: 'Token refresh temporarily unavailable' }, 503, { 'Retry-After': '1' })
  }

  context.data.sessionId = sessionId
  context.data.accessToken = validSession.access_token
  context.data.session = validSession

  const response = await context.next()

  // getValidSession above already persisted a refreshed token itself (mutating and
  // saving `session` in place — see its own doc comment), so this block only needs to
  // handle the sliding-TTL renewal stamp; it doesn't also need to detect and re-persist
  // a refresh that already happened.
  const needsRenew = !validSession.renewed_at || Date.now() - validSession.renewed_at > RENEW_INTERVAL
  if (needsRenew) {
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
