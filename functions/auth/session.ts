import type { Env } from '../_shared/session'
import { parseSessionId, getSession, saveSession, makeSessionCookie, SESSION_TTL } from '../_shared/session'
import { GoogleAccessTokenValidationError, GoogleIdTokenValidationError, verifyGoogleAccessToken, verifyGoogleIdToken } from '../_shared/google'

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const sessionId = parseSessionId(request)
  const authorization = request.headers.get('Authorization') ?? ''
  const token = /^Bearer\s+([^\s]+)$/i.exec(authorization)?.[1]
  const idToken = request.headers.get('X-Linger-Google-ID-Token') ?? ''
  if (!sessionId || !token || !idToken) return signedOutResponse()

  const session = await getSession(sessionId, env, request.headers.get('X-Linger-Vault-Key') ?? undefined)
  if (!session?.user_id || session.user_id !== request.headers.get('X-Linger-Vault-User')) return signedOutResponse()
  let email: string | null = null
  try {
    const claims = await verifyGoogleIdToken(idToken, env.GOOGLE_CLIENT_ID)
    if (session.google_sub && claims.sub !== session.google_sub) return signedOutResponse()
    const expiresIn = await verifyGoogleAccessToken(token, env.GOOGLE_CLIENT_ID, claims.sub)
    session.google_sub = claims.sub
    session.client_id = env.GOOGLE_CLIENT_ID
    email = claims.email?.trim().toLowerCase() ?? null
    // These values are request-local only. The metadata projection in authStore.ts
    // prevents them from being written even if this object is later saved.
    session.access_token = token
    session.expires_at = Date.now() + expiresIn * 1000
    session.id_token = idToken
    session.id_token_verified = true
    await saveSession(sessionId, session, env)
  } catch (error) {
    if (error instanceof GoogleAccessTokenValidationError && error.transient) {
      return new Response(JSON.stringify({ error: 'Google authorization temporarily unavailable' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '1' },
      })
    }
    if (error instanceof GoogleIdTokenValidationError && error.transient) {
      return new Response(JSON.stringify({ error: 'Google identity validation temporarily unavailable' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '1' },
      })
    }
    return signedOutResponse()
  }

  const secure = !env.SESSION_DOMAIN.startsWith('http://')
  const headers = new Headers({
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  headers.append('Set-Cookie', makeSessionCookie(sessionId, SESSION_TTL, secure))
  return new Response(JSON.stringify({
    signedIn: true,
    userId: session.user_id,
    email,
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
