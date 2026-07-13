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
  // client_id is the GOOGLE_CLIENT_ID that actually minted this session's
  // id_token (its `aud` claim) — falls back to the live env value for legacy
  // sessions that predate this field, though those never held an id_token anyway.
  return new Response(JSON.stringify({
    signedIn: true,
    email: session.email ?? null,
    googleSub: session.google_sub ?? null,
    googleClientId: session.client_id ?? env.GOOGLE_CLIENT_ID,
  }), { status: 200, headers })
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
