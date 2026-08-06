import type { Env, SessionData } from '../_shared/session'
import { saveSession, addEmailSessionIndex, addSubSessionIndex, getRefreshTokenForEmail, getRefreshTokenForSub, makeSessionCookie, clearOAuthStateCookie, parseOAuthStateCookie, SESSION_TTL, jsonResponse } from '../_shared/session'
import { verifyGoogleIdToken } from '../_shared/google'

// Inserts `key=value` before any `#fragment` in `path` (a query string can't
// follow a fragment), joining with `&` if `path` already has a query string.
function withQueryParam(path: string, key: string, value: string): string {
  const hashIdx = path.indexOf('#')
  const base = hashIdx === -1 ? path : path.slice(0, hashIdx)
  const hash = hashIdx === -1 ? '' : path.slice(hashIdx)
  const separator = base.includes('?') ? '&' : '?'
  return `${base}${separator}${key}=${encodeURIComponent(value)}${hash}`
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

  const stateRecordRaw = await env.SESSIONS.get(`oauth_state:${state}`)
  if (!stateRecordRaw) {
    return jsonResponse({ error: 'Invalid or expired state' }, 400)
  }
  await env.SESSIONS.delete(`oauth_state:${state}`)

  let stateRecord: { codeVerifier: string; nonce: string; returnPath: string }
  try {
    const parsed = JSON.parse(stateRecordRaw) as Partial<typeof stateRecord>
    stateRecord = parsed.codeVerifier
      ? { codeVerifier: parsed.codeVerifier, nonce: parsed.nonce ?? '', returnPath: parsed.returnPath ?? '/' }
      : { codeVerifier: stateRecordRaw, nonce: '', returnPath: '/' }
  } catch {
    stateRecord = { codeVerifier: stateRecordRaw, nonce: '', returnPath: '/' }
  }
  const safeReturnPath = (stateRecord.returnPath.startsWith('/') && !stateRecord.returnPath.startsWith('//')) ? stateRecord.returnPath : '/'

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
    refresh_token?: string
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

  // Google only returns a refresh_token on the first authorization. On repeat
  // sign-ins (no prompt=consent), reuse the one stored from a previous session.
  let refreshToken = tokens.refresh_token
  if (!refreshToken) {
    refreshToken = (await getRefreshTokenForSub(googleSub, env.GOOGLE_CLIENT_ID, env)) ?? undefined
    if (!refreshToken && email) {
      // Legacy sessions created before sub indexing are still migrated on login.
      refreshToken = (await getRefreshTokenForEmail(email, env.GOOGLE_CLIENT_ID, env)) ?? undefined
    }
  }
  if (!refreshToken) {
    // Redirect (rather than a raw JSON error page, which is what the browser would
    // otherwise render for this full-page navigation) so the frontend can show a
    // friendly explanation with recovery steps — see App.tsx's `auth_error` handling.
    return new Response(null, {
      status: 302,
      headers: { Location: withQueryParam(safeReturnPath, 'auth_error', 'no_refresh_token'), 'Set-Cookie': clearOAuthStateCookie(secure) },
    })
  }

  const sessionId = crypto.randomUUID()
  const session: SessionData = {
    refresh_token: refreshToken,
    access_token: tokens.access_token,
    expires_at: Date.now() + tokens.expires_in * 1000,
    client_id: env.GOOGLE_CLIENT_ID,
    ...(email ? { email } : {}),
    ...(tokens.id_token ? { id_token: tokens.id_token } : {}),
    id_token_verified: true,
    ...(googleSub ? { google_sub: googleSub } : {}),
  }
  // Written before saveSession: if the index write fails, no session was ever
  // created (fails the login, visibly and retryably); if saveSession instead
  // failed *after* a successful index write, the only trace left is a dangling
  // index entry pointing at a session that doesn't exist — harmless, since
  // getSession/getRefreshTokenForEmail already treat a missing session record
  // as absent. The other order risks the opposite and worse case: a live
  // session with no index entry, invisible to /auth/risc's revocation.
  if (email) {
    await addEmailSessionIndex(email, sessionId, env)
  }
  await addSubSessionIndex(googleSub, sessionId, env)
  await saveSession(sessionId, session, env)

  const headers = new Headers({
    Location: safeReturnPath,
  })
  headers.append('Set-Cookie', makeSessionCookie(sessionId, SESSION_TTL, secure))
  headers.append('Set-Cookie', clearOAuthStateCookie(secure))
  return new Response(null, {
    status: 302,
    headers,
  })
}
