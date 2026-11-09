import type { Env } from '../_shared/session'
import { getSession, jsonResponse, parseSessionId, validateMutationOrigin } from '../_shared/session'
import { openVaultValue, sealVaultValue } from '../_shared/vaultCrypto'
import { verifyGoogleAccessToken, verifyGoogleIdToken } from '../_shared/google'
import { sessionStorageId } from '../_shared/authStore'

interface StoredRefresh { token: string }

// The supplied vault key and Google tokens exist only for this request.
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const originError = validateMutationOrigin(request, env)
  if (originError) return originError
  const id = parseSessionId(request)
  const key = request.headers.get('X-Linger-Vault-Key') ?? undefined
  if (!id || !key || !env.AUTH_DB) return jsonResponse({ error: 'Vault unlock required' }, 401)
  const session = await getSession(id, env, key)
  if (!session?.user_id || session.user_id !== request.headers.get('X-Linger-Vault-User') || !session.google_sub) {
    return jsonResponse({ error: 'Linked account required' }, 401)
  }
  let body: { refreshToken?: unknown }
  try { body = await request.json() as typeof body } catch { return jsonResponse({ error: 'Invalid request' }, 400) }
  if (!body || typeof body !== 'object') return jsonResponse({ error: 'Invalid request' }, 400)
  const supplied = body.refreshToken
  if (supplied !== undefined && (typeof supplied !== 'string' || !supplied || supplied.length > 4096)) return jsonResponse({ error: 'Invalid credential' }, 400)
  let token: string
  let previousEnvelope: string | null = null
  try {
    if (typeof supplied === 'string') token = supplied
    else {
      const row = await env.AUTH_DB.prepare('SELECT envelope FROM google_refresh_vault WHERE user_id = ?').bind(session.user_id).first<{ envelope: string }>()
      if (!row) return jsonResponse({ error: 'Google authorization required' }, 401)
      previousEnvelope = row.envelope
      const stored = await openVaultValue<StoredRefresh>(key, session.user_id, 'google-refresh-token', row.envelope)
      if (!stored || typeof stored.token !== 'string' || !stored.token) throw new Error('Invalid stored credential')
      token = stored.token
    }
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: token, grant_type: 'refresh_token' }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return jsonResponse({ error: 'Google authorization unavailable' }, response.status === 400 || response.status === 401 ? 401 : 503)
    const result = await response.json() as { access_token?: unknown; id_token?: unknown; expires_in?: unknown; refresh_token?: unknown }
    if (typeof result.access_token !== 'string' || typeof result.id_token !== 'string' || typeof result.expires_in !== 'number' || !Number.isFinite(result.expires_in) || result.expires_in <= 0) throw new Error('Invalid token response')
    const claims = await verifyGoogleIdToken(result.id_token, env.GOOGLE_CLIENT_ID)
    if (claims.sub !== session.google_sub) return jsonResponse({ error: 'Google account mismatch' }, 401)
    await verifyGoogleAccessToken(result.access_token, env.GOOGLE_CLIENT_ID, claims.sub)
    const active = await getSession(id, env, key)
    if (!active || active.user_id !== session.user_id || active.google_sub !== session.google_sub) return jsonResponse({ error: 'Session expired' }, 401)
    const nextToken = typeof result.refresh_token === 'string' && result.refresh_token ? result.refresh_token : token
    if (typeof supplied === 'string' || nextToken !== token) {
      const envelope = await sealVaultValue(key, session.user_id, 'google-refresh-token', { token: nextToken })
      // Recheck the live session before committing credentials after network calls.
      const saved = await env.AUTH_DB.prepare(`INSERT INTO google_refresh_vault (user_id, envelope, updated_at)
        SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM auth_sessions s WHERE s.id = ? AND s.user_id = ? AND s.revoked = 0 AND s.expires_at > ?
          AND (s.credential_id IS NULL OR EXISTS (SELECT 1 FROM passkey_credentials c WHERE c.credential_id = s.credential_id AND c.user_id = s.user_id)))
        ON CONFLICT(user_id) DO UPDATE SET envelope = excluded.envelope, updated_at = excluded.updated_at
          WHERE ? IS NULL OR google_refresh_vault.envelope = ? RETURNING user_id`)
        .bind(session.user_id, envelope, Date.now(), await sessionStorageId(id), session.user_id, Date.now(), previousEnvelope, previousEnvelope).first()
      if (!saved) return jsonResponse({ error: 'Session or credential changed; retry' }, 409)
    }
    return jsonResponse({ accessToken: result.access_token, idToken: result.id_token, expiresAt: Date.now() + result.expires_in * 1000 }, 200, { 'Cache-Control': 'no-store' })
  } catch {
    return jsonResponse({ error: 'Google authorization unavailable' }, 503, { 'Cache-Control': 'no-store' })
  }
}
