import type { Env } from '../_shared/session'
import { jsonResponse, makeOAuthStateCookie, makeOAuthPkceCookie } from '../_shared/session'
import { saveOAuthState } from '../_shared/authStore'

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

export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const state = crypto.randomUUID()
  const codeVerifier = randomVerifier()
  const nonce = crypto.randomUUID()
  const codeChallenge = base64url(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier))
  )

  // Keep the PKCE secret in a short lived, HttpOnly browser cookie. The server
  // store only needs nonce and response mode after atomically consuming state.
  await saveOAuthState(state, JSON.stringify({ nonce, popup: true }), env)

  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${env.SESSION_DOMAIN}/auth/callback`,
    response_type: 'code',
    scope: SCOPE,
    state,
    nonce,
    access_type: 'online',
    // Do not union these permissions with broader scopes granted in the past.
    include_granted_scopes: 'false',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  })
  // Let Google use its normal account/session selection for the primary
  // sign-in action. The explicit secondary action asks Google to show accounts.
  if (new URL(request.url).searchParams.get('select_account') === '1') {
    params.set('prompt', 'select_account')
  }

  const headers = new Headers({ Location: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` })
  headers.append('Set-Cookie', makeOAuthStateCookie(state, !env.SESSION_DOMAIN.startsWith('http://')))
  headers.append('Set-Cookie', makeOAuthPkceCookie(codeVerifier, !env.SESSION_DOMAIN.startsWith('http://')))
  return new Response(null, {
    status: 302,
    headers,
  })
}

export const onRequestPost: PagesFunction<Env> = async () => {
  return jsonResponse({ error: 'Method not allowed' }, 405)
}
