import type { Env } from '../_shared/session'
import { jsonResponse, makeOAuthStateCookie, OAUTH_STATE_TTL } from '../_shared/session'

const SCOPE = 'https://www.googleapis.com/auth/drive.file openid email'

function base64url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomVerifier(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return base64url(bytes.buffer)
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const state = crypto.randomUUID()
  const codeVerifier = randomVerifier()
  const nonce = crypto.randomUUID()
  const codeChallenge = base64url(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier))
  )

  const rawReturnPath = new URL(request.url).searchParams.get('redirect') ?? '/'
  const returnPath = (rawReturnPath.startsWith('/') && !rawReturnPath.startsWith('//')) ? rawReturnPath : '/'
  await env.SESSIONS.put(`oauth_state:${state}`, JSON.stringify({ codeVerifier, nonce, returnPath }), { expirationTtl: OAUTH_STATE_TTL })

  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${env.SESSION_DOMAIN}/auth/callback`,
    response_type: 'code',
    scope: SCOPE,
    state,
    nonce,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  })

  return new Response(null, {
    status: 302,
    headers: {
      Location: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
      'Set-Cookie': makeOAuthStateCookie(state, !env.SESSION_DOMAIN.startsWith('http://')),
    },
  })
}

export const onRequestPost: PagesFunction<Env> = async () => {
  return jsonResponse({ error: 'Method not allowed' }, 405)
}
