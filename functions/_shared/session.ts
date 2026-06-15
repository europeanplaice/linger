export const SESSION_TTL = 60 * 60 * 24 * 30 // 30 days

const COOKIE_NAME = 'linger_session'

export interface Env {
  SESSIONS: KVNamespace
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  SESSION_DOMAIN: string
}

export interface SessionData {
  refresh_token: string
  access_token: string
  expires_at: number // ms since epoch
  folder_id?: string
  renewed_at?: number // ms since epoch — tracks last KV write to throttle sliding TTL renewal
  email?: string
  changes_start_page_token?: string // Drive Changes API page token for incremental sync
}

export interface Data extends Record<string, unknown> {
  sessionId: string
  accessToken: string
  session: SessionData
}

export function parseSessionId(request: Request): string | null {
  const header = request.headers.get('Cookie') ?? ''
  for (const part of header.split(';')) {
    const trimmed = part.trim()
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const name = trimmed.slice(0, eq)
    const value = trimmed.slice(eq + 1)
    if (name === COOKIE_NAME && value) return decodeURIComponent(value)
  }
  return null
}

export async function getSession(sessionId: string, env: Env): Promise<SessionData | null> {
  const raw = await env.SESSIONS.get(`session:${sessionId}`)
  if (!raw) return null
  try {
    return JSON.parse(raw) as SessionData
  } catch {
    return null
  }
}

export async function saveSession(sessionId: string, session: SessionData, env: Env): Promise<void> {
  await env.SESSIONS.put(`session:${sessionId}`, JSON.stringify(session), { expirationTtl: SESSION_TTL })
}

export async function getValidSession(_sessionId: string, session: SessionData, env: Env): Promise<SessionData> {
  if (session.expires_at > Date.now() + 60_000) {
    return session
  }
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: session.refresh_token,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }).toString(),
  })
  if (!resp.ok) {
    throw new Error(`Token refresh failed: ${resp.status}`)
  }
  const tokens = await resp.json() as { access_token: string; expires_in: number }
  const updated: SessionData = {
    ...session,
    access_token: tokens.access_token,
    expires_at: Date.now() + tokens.expires_in * 1000,
  }
  return updated
}

export async function getValidAccessToken(sessionId: string, session: SessionData, env: Env): Promise<string> {
  const validSession = await getValidSession(sessionId, session, env)
  if (validSession !== session) {
    await saveSession(sessionId, validSession, env)
  }
  return validSession.access_token
}

export function makeSessionCookie(sessionId: string, maxAge: number, secure = true): string {
  const secureFlag = secure ? '; Secure' : ''
  return `${COOKIE_NAME}=${encodeURIComponent(sessionId)}; HttpOnly${secureFlag}; SameSite=Strict; Path=/; Max-Age=${maxAge}`
}

export function clearSessionCookie(secure = true): string {
  const secureFlag = secure ? '; Secure' : ''
  return `${COOKIE_NAME}=; HttpOnly${secureFlag}; SameSite=Strict; Path=/; Max-Age=0`
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export async function addEmailSessionIndex(email: string, sessionId: string, env: Env): Promise<void> {
  const key = `email_sessions:${normalizeEmail(email)}`
  const raw = await env.SESSIONS.get(key)
  const ids: string[] = raw ? (JSON.parse(raw) as string[]) : []
  if (!ids.includes(sessionId)) {
    ids.push(sessionId)
    await env.SESSIONS.put(key, JSON.stringify(ids), { expirationTtl: SESSION_TTL })
  }
}

export async function getRefreshTokenForEmail(email: string, env: Env): Promise<string | null> {
  const key = `email_sessions:${normalizeEmail(email)}`
  const raw = await env.SESSIONS.get(key)
  if (!raw) return null
  const ids = JSON.parse(raw) as string[]
  for (const id of ids) {
    const session = await getSession(id, env)
    if (session?.refresh_token) return session.refresh_token
  }
  return null
}

export async function removeEmailSessionIndex(email: string, sessionId: string, env: Env): Promise<void> {
  const key = `email_sessions:${normalizeEmail(email)}`
  const raw = await env.SESSIONS.get(key)
  if (!raw) return
  const ids = (JSON.parse(raw) as string[]).filter(id => id !== sessionId)
  if (ids.length === 0) {
    await env.SESSIONS.delete(key)
  } else {
    await env.SESSIONS.put(key, JSON.stringify(ids), { expirationTtl: SESSION_TTL })
  }
}

export async function deleteAllSessionsForEmail(email: string, env: Env): Promise<void> {
  const key = `email_sessions:${normalizeEmail(email)}`
  const raw = await env.SESSIONS.get(key)
  if (!raw) return
  const ids = JSON.parse(raw) as string[]
  const results = await Promise.allSettled(ids.map(id => env.SESSIONS.delete(`session:${id}`)))
  const failedIds = ids.filter((_, i) => results[i].status === 'rejected')
  if (failedIds.length === 0) {
    await env.SESSIONS.delete(key)
  } else {
    await env.SESSIONS.put(key, JSON.stringify(failedIds), { expirationTtl: SESSION_TTL })
  }
}

export function jsonResponse(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  })
}

function originOf(value: string): string | null {
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

function allowedOrigins(request: Request, env: Env): Set<string> {
  const origins = new Set<string>()
  const sessionOrigin = originOf(env.SESSION_DOMAIN)
  const requestOrigin = originOf(request.url)
  if (sessionOrigin) origins.add(sessionOrigin)
  if (requestOrigin) origins.add(requestOrigin)

  // Local development commonly proxies Vite (5173) to Pages Functions (8788).
  if (sessionOrigin?.startsWith('http://localhost') || sessionOrigin?.startsWith('http://127.0.0.1')) {
    origins.add('http://localhost:5173')
    origins.add('http://127.0.0.1:5173')
  }

  return origins
}

export function validateMutationOrigin(request: Request, env: Env): Response | null {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method.toUpperCase())) return null

  const origin = request.headers.get('Origin')
  if (origin && !allowedOrigins(request, env).has(origin)) {
    return jsonResponse({ error: 'Forbidden' }, 403)
  }

  const fetchSite = request.headers.get('Sec-Fetch-Site')
  // 'none' means the request has no browsing context initiator (e.g. browser extension,
  // direct navigation) — not a cross-site page load, so it is safe to allow.
  if (fetchSite && !['same-origin', 'same-site', 'none'].includes(fetchSite)) {
    return jsonResponse({ error: 'Forbidden' }, 403)
  }

  return null
}
