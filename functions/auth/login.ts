import type { Env } from '../_shared/session'
import { jsonResponse, makeOAuthStateCookie, makeOAuthPkceCookie, parseSessionId } from '../_shared/session'
import { saveOAuthState, getPasskeySessionUserId, sessionStorageId } from '../_shared/authStore'

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
  const sessionId = parseSessionId(request)
  const userId = sessionId ? await getPasskeySessionUserId(sessionId, env) : null
  const url = new URL(request.url)
  const setup = url.searchParams.get('setup') === '1'
  if ((!sessionId || !userId) && !setup) return jsonResponse({ error: 'Unlock Linger with a passkey first' }, 401)
  const requestedChannelId = url.searchParams.get('channel_id')
  const channelId = requestedChannelId && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedChannelId)
    ? requestedChannelId
    : undefined
  const state = crypto.randomUUID()
  const codeVerifier = randomVerifier()
  const nonce = crypto.randomUUID()
  const codeChallenge = base64url(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier))
  )

  // Keep the PKCE secret in a short lived, HttpOnly browser cookie. The server
  // store only needs nonce and response mode after atomically consuming state.
  await saveOAuthState(state, JSON.stringify({ nonce, popup: true, channelId, setup, userId, sessionHandle: sessionId && userId ? await sessionStorageId(sessionId) : undefined }), env)

  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${env.SESSION_DOMAIN}/auth/callback`,
    response_type: 'code',
    scope: SCOPE,
    state,
    nonce,
    access_type: 'offline',
    // Do not union these permissions with broader scopes granted in the past.
    include_granted_scopes: 'false',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  })
  // Let Google use its normal account/session selection for the primary
  // sign-in action. The explicit secondary action asks Google to show accounts.
  const prompts: string[] = []
  if (url.searchParams.get('select_account') === '1') prompts.push('select_account')
  // Initial setup and credential recovery need a new offline credential.
  // Otherwise a confirmed working saved credential can be retained.
  if (setup || url.searchParams.get('reuse') !== '1') prompts.push('consent')
  if (prompts.length) params.set('prompt', prompts.join(' '))

  const headers = new Headers({ Location: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` })
  headers.append('Set-Cookie', makeOAuthStateCookie(state, !env.SESSION_DOMAIN.startsWith('http://')))
  headers.append('Set-Cookie', makeOAuthPkceCookie(codeVerifier, !env.SESSION_DOMAIN.startsWith('http://'), state))
  return new Response(null, {
    status: 302,
    headers,
  })
}

export const onRequestPost: PagesFunction<Env> = async () => {
  return jsonResponse({ error: 'Method not allowed' }, 405)
}
