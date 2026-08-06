import type { Env } from '../_shared/session'
import { parseSessionId, getSession, invalidateSession, clearSessionCookie, validateMutationOrigin } from '../_shared/session'

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const originError = validateMutationOrigin(request, env)
  if (originError) return originError

  const sessionId = parseSessionId(request)
  if (sessionId) {
    const session = await getSession(sessionId, env)
    await invalidateSession(sessionId, session?.email, env, session?.google_sub)
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': clearSessionCookie(!env.SESSION_DOMAIN.startsWith('http://')),
    },
  })
}
