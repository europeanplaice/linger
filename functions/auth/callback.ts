import type { Env, SessionData } from '../_shared/session'
import { createSession, addEmailSessionIndex, addSubSessionIndex, makeSessionCookie, clearOAuthStateCookie, parseOAuthStateCookie, SESSION_TTL, jsonResponse } from '../_shared/session'
import { consumeOAuthState } from '../_shared/authStore'
import { verifyGoogleIdToken } from '../_shared/google'

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function popupCredentialResponse(payload: { accessToken: string; idToken: string; expiresAt: number }, origin: string, secure: boolean): Response {
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(18)))
  const encoded = base64url(new TextEncoder().encode(JSON.stringify(payload)))
  const html = `<!doctype html><meta charset="utf-8"><title>Google sign-in</title><p>Returning to Linger…</p><script nonce="${nonce}">
    const encoded = '${encoded}'.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(encoded + '='.repeat((4 - encoded.length % 4) % 4)), c => c.charCodeAt(0));
    const credential = JSON.parse(new TextDecoder().decode(bytes));
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage({ type: 'linger-oauth-complete', credential }, '${origin}');
      window.close();
    } else {
      document.querySelector('p').textContent = 'Sign-in finished. Return to the Linger tab.';
    }
  </script>`
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`,
      'Set-Cookie': clearOAuthStateCookie(secure),
    },
  })
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const stateParam = url.searchParams.get('state') ?? ''

  const state = stateParam
  const secure = !env.SESSION_DOMAIN.startsWith('http://')

  if (!code || !state || parseOAuthStateCookie(request) !== state) {
    return jsonResponse({ error: 'Missing code or state' }, 400)
  }

  const stateRecordRaw = await consumeOAuthState(state, env)
  if (!stateRecordRaw) {
    return jsonResponse({ error: 'Invalid or expired state' }, 400)
  }

  let stateRecord: { codeVerifier: string; nonce: string; popup: boolean }
  try {
    const parsed = JSON.parse(stateRecordRaw) as Partial<typeof stateRecord>
    stateRecord = parsed.codeVerifier
      ? { codeVerifier: parsed.codeVerifier, nonce: parsed.nonce ?? '', popup: parsed.popup === true }
      : { codeVerifier: stateRecordRaw, nonce: '', popup: false }
  } catch {
    stateRecord = { codeVerifier: stateRecordRaw, nonce: '', popup: false }
  }

  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${env.SESSION_DOMAIN}/auth/callback`,
      grant_type: 'authorization_code',
      code_verifier: stateRecord.codeVerifier,
    }).toString(),
  })

  if (!tokenResp.ok) {
    // Not 502/503/504 — Cloudflare's edge silently replaces those status codes with
    // its own branded error page, discarding this JSON body entirely.
    return jsonResponse({ error: 'Authentication failed. Please try again.' }, 500)
  }

  const tokens = await tokenResp.json() as {
    access_token: string
    expires_in: number
    id_token?: string
  }

  if (!tokens.id_token) return jsonResponse({ error: 'Authentication failed. Please try again.' }, 500)
  let claims
  try {
    claims = await verifyGoogleIdToken(tokens.id_token, env.GOOGLE_CLIENT_ID, stateRecord.nonce || undefined)
  } catch {
    return jsonResponse({ error: 'Authentication failed. Please try again.' }, 500)
  }
  const email = claims.email?.trim().toLowerCase()
  const googleSub = claims.sub

  const sessionId = crypto.randomUUID()
  const session: SessionData = {
    client_id: env.GOOGLE_CLIENT_ID,
    ...(email ? { email } : {}),
    ...(googleSub ? { google_sub: googleSub } : {}),
  }
  // D1 creates the session and identity indexes atomically. These helpers are
  // no-ops there; retain the ordering below for KV-only deployments.
  // Written before createSession: if the index write fails, no session was ever
  // created (fails the login, visibly and retryably); if saveSession instead
  // failed *after* a successful index write, the only trace left is a dangling
  // index entry pointing at a session that doesn't exist — harmless, since
  // getSession already treats a missing session record
  // as absent. The other order risks the opposite and worse case: a live
  // session with no index entry, invisible to /auth/risc's revocation.
  if (email) {
    await addEmailSessionIndex(email, sessionId, env)
  }
  await addSubSessionIndex(googleSub, sessionId, env)
  await createSession(sessionId, session, env)

  const credential = {
    accessToken: tokens.access_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    idToken: tokens.id_token,
  }
  if (stateRecord.popup) {
    const response = popupCredentialResponse(credential, new URL(env.SESSION_DOMAIN).origin, secure)
    const headers = new Headers(response.headers)
    headers.append('Set-Cookie', makeSessionCookie(sessionId, SESSION_TTL, secure))
    return new Response(response.body, { status: response.status, headers })
  }
  return jsonResponse({ error: 'Popup sign-in required' }, 400, { 'Set-Cookie': clearOAuthStateCookie(secure) })
}
