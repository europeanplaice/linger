import type { Env } from '../_shared/session'
import { jsonResponse } from '../_shared/session'

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
  const codeChallenge = base64url(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier))
  )

  await env.SESSIONS.put(`oauth_state:${state}`, codeVerifier, { expirationTtl: 300 })

  const rawReturnPath = new URL(request.url).searchParams.get('redirect') ?? '/'
  const returnPath = (rawReturnPath.startsWith('/') && !rawReturnPath.startsWith('//')) ? rawReturnPath : '/'

  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${env.SESSION_DOMAIN}/auth/callback`,
    response_type: 'code',
    scope: SCOPE,
    state: `${state}:${encodeURIComponent(returnPath)}`,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  })

  return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`, 302)
}

export const onRequestPost: PagesFunction<Env> = async () => {
  return jsonResponse({ error: 'Method not allowed' }, 405)
}
