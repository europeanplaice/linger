import type { Env } from '../_shared/session'
import { parseSessionId, getSession, makeSessionCookie, SESSION_TTL } from '../_shared/session'

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const sessionId = parseSessionId(request)
  if (!sessionId) return signedOutResponse()

  const session = await getSession(sessionId, env)
  if (session === null) return signedOutResponse()

  const secure = !env.SESSION_DOMAIN.startsWith('http://')
  const headers = new Headers({
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  headers.append('Set-Cookie', makeSessionCookie(sessionId, SESSION_TTL, secure))
  return new Response(JSON.stringify({ signedIn: true, email: session.email ?? null, googleSub: session.google_sub ?? null }), { status: 200, headers })
}

function signedOutResponse(): Response {
  return new Response(JSON.stringify({ signedIn: false }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
