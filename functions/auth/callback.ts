import type { Env } from '../_shared/session'
import { clearOAuthStateCookie, clearOAuthPkceCookie, parseOAuthStateCookie, parseOAuthPkceCookie, jsonResponse } from '../_shared/session'
import { consumeOAuthState } from '../_shared/authStore'
import { verifyGoogleIdToken } from '../_shared/google'

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function popupCredentialResponse(payload: { accessToken: string; idToken: string; expiresAt: number }, origin: string, channelId: string | undefined, secure: boolean): Response {
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(18)))
  const encoded = base64url(new TextEncoder().encode(JSON.stringify(payload)))
  const encodedChannelId = JSON.stringify(channelId ?? '')
  const html = `<!doctype html><meta charset="utf-8"><title>Google sign-in</title><p>Returning to Linger…</p><script nonce="${nonce}">
    const encoded = '${encoded}'.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(encoded + '='.repeat((4 - encoded.length % 4) % 4)), c => c.charCodeAt(0));
    const credential = JSON.parse(new TextDecoder().decode(bytes));
    const channelId = ${encodedChannelId};
    const message = { type: 'linger-oauth-complete', credential, ...(channelId ? { channelId } : {}) };
    const status = document.querySelector('p');
    let acknowledged = false;
    let channel = null;
    if (channelId && 'BroadcastChannel' in window) {
      try {
        channel = new BroadcastChannel('linger-oauth-' + channelId);
        channel.onmessage = event => {
          if (event.data?.type !== 'linger-oauth-ack' || event.data.channelId !== channelId) return;
          acknowledged = true;
          clearTimeout(recoveryTimer);
          status.textContent = 'Sign-in complete. Return to Linger.';
          channel.close();
        };
      } catch { channel = null; }
    }
    let delivered = false;
    if (window.opener && !window.opener.closed) {
      try {
        window.opener.postMessage(message, '${origin}');
        delivered = true;
      } catch { /* A cross-origin opener cannot receive credentials. */ }
    }
    if (channel) {
      try { channel.postMessage(message); delivered = true; }
      catch { channel.close(); channel = null; }
    }
    status.textContent = delivered ? 'Finishing sign-in in Linger…' : 'Sign-in finished, but Linger could not be reached. Return to the Linger tab and try again.';
    const recoveryTimer = setTimeout(() => {
      if (!acknowledged) status.textContent = 'Linger has not confirmed sign-in. Return to the Linger tab and try again.';
      channel?.close();
    }, 10000);
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

function consumedStateError(body: unknown, status: number, secure: boolean): Response {
  const response = jsonResponse(body, status)
  const headers = new Headers(response.headers)
  headers.append('Set-Cookie', clearOAuthStateCookie(secure))
  headers.append('Set-Cookie', clearOAuthPkceCookie(secure))
  return new Response(response.body, { status, headers })
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
  if (!stateRecordRaw) return jsonResponse({ error: 'Invalid or expired state' }, 400)

  let stateRecord: { codeVerifier?: string; nonce: string; popup: boolean; channelId?: string; userId?: string; sessionHandle?: string }
  try {
    const parsed = JSON.parse(stateRecordRaw) as Partial<typeof stateRecord>
    stateRecord = {
      codeVerifier: parsed.codeVerifier,
      userId: parsed.userId,
      sessionHandle: parsed.sessionHandle,
      nonce: parsed.nonce ?? '',
      popup: parsed.popup === true,
      channelId: typeof parsed.channelId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.channelId)
        ? parsed.channelId
        : undefined,
    }
  } catch {
    stateRecord = { codeVerifier: stateRecordRaw, nonce: '', popup: false }
  }

  // The Strict session cookie is not sent on Google's cross-site callback.
  // Bind the one-use OAuth state to the passkey session captured before redirect.
  if (!env.AUTH_DB || !stateRecord.userId || !/^sha256:[0-9a-f]{64}$/.test(stateRecord.sessionHandle ?? '')) {
    return consumedStateError({ error: 'Passkey session required' }, 401, secure)
  }
  const active = await env.AUTH_DB.prepare('SELECT user_id FROM auth_sessions WHERE id = ? AND user_id = ? AND revoked = 0 AND expires_at > ?')
    .bind(stateRecord.sessionHandle, stateRecord.userId, Date.now()).first()
  if (!active) return consumedStateError({ error: 'Passkey session expired' }, 401, secure)

  // Support attempts created before PKCE moved to the short lived browser cookie.
  const codeVerifier = stateRecord.codeVerifier ?? parseOAuthPkceCookie(request)
  if (!codeVerifier) return consumedStateError({ error: 'Invalid or expired state' }, 400, secure)

  let tokenResp: Response
  try {
    tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${env.SESSION_DOMAIN}/auth/callback`,
        grant_type: 'authorization_code',
        code_verifier: codeVerifier,
      }).toString(),
    })
  } catch {
    return consumedStateError({ error: 'Authentication failed. Please try again.' }, 500, secure)
  }

  if (!tokenResp.ok) {
    // Not 502/503/504 — Cloudflare's edge silently replaces those status codes with
    // its own branded error page, discarding this JSON body entirely.
    return consumedStateError({ error: 'Authentication failed. Please try again.' }, 500, secure)
  }

  let tokenPayload: unknown
  try {
    tokenPayload = await tokenResp.json()
  } catch {
    return consumedStateError({ error: 'Authentication failed. Please try again.' }, 500, secure)
  }

  if (!tokenPayload || typeof tokenPayload !== 'object' || Array.isArray(tokenPayload)) {
    return consumedStateError({ error: 'Authentication failed. Please try again.' }, 500, secure)
  }
  const responseFields = tokenPayload as Record<string, unknown>
  if (typeof responseFields.access_token !== 'string' || !responseFields.access_token ||
    typeof responseFields.id_token !== 'string' || !responseFields.id_token ||
    typeof responseFields.expires_in !== 'number' || !Number.isFinite(responseFields.expires_in) || responseFields.expires_in <= 0) {
    return consumedStateError({ error: 'Authentication failed. Please try again.' }, 500, secure)
  }
  const tokens = {
    access_token: responseFields.access_token,
    id_token: responseFields.id_token,
    expires_in: responseFields.expires_in,
  }
  let claims
  try {
    claims = await verifyGoogleIdToken(tokens.id_token, env.GOOGLE_CLIENT_ID, stateRecord.nonce || undefined)
  } catch {
    return consumedStateError({ error: 'Authentication failed. Please try again.' }, 500, secure)
  }
  // Google identity and credentials remain in this response's memory only.
  // /auth/session verifies them again and seals account metadata with the user's
  // request-scoped key; the OAuth callback has no key and writes no profile.
  void claims

  const credential = {
    accessToken: tokens.access_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    idToken: tokens.id_token,
  }
  if (stateRecord.popup) {
    const response = popupCredentialResponse(credential, new URL(env.SESSION_DOMAIN).origin, stateRecord.channelId, secure)
    const headers = new Headers(response.headers)
    headers.append('Set-Cookie', clearOAuthPkceCookie(secure))
    return new Response(response.body, { status: response.status, headers })
  }
  return consumedStateError({ error: 'Popup sign-in required' }, 400, secure)
}
