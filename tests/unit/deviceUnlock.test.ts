import { describe, expect, it } from 'vitest'
import { onRequestDelete, onRequestGet, onRequestPost } from '../../functions/auth/passkey/device-unlock'
import { onRequestPost as onLogout } from '../../functions/auth/logout'
import { sessionStorageId } from '../../functions/_shared/authStore'
import { DEVICE_UNLOCK_COOKIE, DEVICE_UNLOCK_PATH } from '../../functions/_shared/deviceUnlock'
import { createPasskeyTestEnv } from '../helpers/passkeyAuth'

function extractSetCookieValue(setCookieHeader: string | null, name: string): string | null {
  if (!setCookieHeader) return null
  const prefix = `${name}=`
  for (const part of setCookieHeader.split(',')) {
    const trimmed = part.trim()
    if (!trimmed.startsWith(prefix)) continue
    const end = trimmed.indexOf(';')
    return end === -1 ? trimmed.slice(prefix.length) : trimmed.slice(prefix.length, end)
  }
  return null
}

describe('device unlock handler', () => {
  it('issues an HttpOnly SameSite=Strict cookie on POST without writing anything to D1', async () => {
    const { env, db, headers, sessionId, userId, key } = await createPasskeyTestEnv({ google_sub: 'google-sub-1' })
    try {
      const beforeSessions = db.prepare('SELECT * FROM auth_sessions').all()
      const beforeUsers = db.prepare('SELECT * FROM passkey_users').all()

      const request = new Request(`https://example.com${DEVICE_UNLOCK_PATH}`, {
        method: 'POST',
        headers: { ...headers, Origin: 'https://example.com', 'Content-Type': 'application/json' },
        body: JSON.stringify({ days: 7 }),
      })
      const response = await onRequestPost({ request, env } as never)
      expect(response.status).toBe(200)
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')

      const setCookie = response.headers.get('Set-Cookie') ?? ''
      expect(setCookie).toContain(`${DEVICE_UNLOCK_COOKIE}=`)
      expect(setCookie).toContain('HttpOnly')
      expect(setCookie).toContain('Secure')
      expect(setCookie).toContain('SameSite=Strict')
      expect(setCookie).toContain(`Path=${DEVICE_UNLOCK_PATH}`)
      expect(setCookie).toContain('Max-Age=604800')

      const body = await response.json() as { userId: string; expiresAt: number; secret: string }
      expect(body.userId).toBe(userId)
      expect(body.secret).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(body.expiresAt).toBeGreaterThan(Date.now() + 6 * 86400 * 1000)

      expect(db.prepare('SELECT * FROM auth_sessions').all()).toEqual(beforeSessions)
      expect(db.prepare('SELECT * FROM passkey_users').all()).toEqual(beforeUsers)
      const dump = JSON.stringify({ sessions: beforeSessions, users: beforeUsers })
      expect(dump).not.toContain(body.secret)
      expect(dump).not.toContain(key)
      expect(sessionId).toBeTruthy()
    } finally { db.close() }
  })

  it('supports 1-day duration and rejects invalid durations or missing auth', async () => {
    const { env, db, headers } = await createPasskeyTestEnv()
    try {
      const oneDay = await onRequestPost({
        request: new Request(`https://example.com${DEVICE_UNLOCK_PATH}`, {
          method: 'POST',
          headers: { ...headers, Origin: 'https://example.com', 'Content-Type': 'application/json' },
          body: JSON.stringify({ days: 1 }),
        }),
        env,
      } as never)
      expect(oneDay.status).toBe(200)
      expect(oneDay.headers.get('Set-Cookie')).toContain('Max-Age=86400')

      for (const invalidBody of [{ days: 0 }, { days: 3 }, { days: 30 }, { days: '7' }]) {
        const res = await onRequestPost({
          request: new Request(`https://example.com${DEVICE_UNLOCK_PATH}`, {
            method: 'POST',
            headers: { ...headers, Origin: 'https://example.com', 'Content-Type': 'application/json' },
            body: JSON.stringify(invalidBody),
          }),
          env,
        } as never)
        expect(res.status).toBe(400)
      }

      const missingKey = await onRequestPost({
        request: new Request(`https://example.com${DEVICE_UNLOCK_PATH}`, {
          method: 'POST',
          headers: { Cookie: headers.Cookie, 'X-Linger-Vault-User': headers['X-Linger-Vault-User'], Origin: 'https://example.com', 'Content-Type': 'application/json' },
          body: JSON.stringify({ days: 1 }),
        }),
        env,
      } as never)
      expect(missingKey.status).toBe(401)
    } finally { db.close() }
  })

  it('returns the wrapping secret on GET when session and cookie match, and rejects revoked/tampered cookies', async () => {
    const { env, db, headers, sessionId, userId } = await createPasskeyTestEnv()
    try {
      const postRes = await onRequestPost({
        request: new Request(`https://example.com${DEVICE_UNLOCK_PATH}`, {
          method: 'POST',
          headers: { ...headers, Origin: 'https://example.com', 'Content-Type': 'application/json' },
          body: JSON.stringify({ days: 1 }),
        }),
        env,
      } as never)
      const issued = await postRes.json() as { userId: string; expiresAt: number; secret: string }
      const cookieValue = extractSetCookieValue(postRes.headers.get('Set-Cookie'), DEVICE_UNLOCK_COOKIE)!
      expect(cookieValue).toBeTruthy()

      const getRes = await onRequestGet({
        request: new Request(`https://example.com${DEVICE_UNLOCK_PATH}`, {
          headers: { Cookie: `${headers.Cookie}; ${DEVICE_UNLOCK_COOKIE}=${cookieValue}`, 'Sec-Fetch-Site': 'same-origin' },
        }),
        env,
      } as never)
      expect(getRes.status).toBe(200)
      expect(getRes.headers.get('Cache-Control')).toBe('no-store')
      expect(await getRes.json()).toEqual(issued)

      // Cross-site GET is rejected with 403
      const crossSite = await onRequestGet({
        request: new Request(`https://example.com${DEVICE_UNLOCK_PATH}`, {
          headers: { Cookie: `${headers.Cookie}; ${DEVICE_UNLOCK_COOKIE}=${cookieValue}`, 'Sec-Fetch-Site': 'cross-site' },
        }),
        env,
      } as never)
      expect(crossSite.status).toBe(403)

      // Tampered userId in cookie fails and clears cookie
      const tampered = encodeURIComponent(`v1.other-user.${issued.expiresAt}.${issued.secret}`)
      const mismatchRes = await onRequestGet({
        request: new Request(`https://example.com${DEVICE_UNLOCK_PATH}`, {
          headers: { Cookie: `${headers.Cookie}; ${DEVICE_UNLOCK_COOKIE}=${tampered}` },
        }),
        env,
      } as never)
      expect(mismatchRes.status).toBe(401)
      expect(mismatchRes.headers.get('Set-Cookie')).toContain('Max-Age=0')

      // Expired cookie fails and clears cookie
      const expiredCookie = encodeURIComponent(`v1.${userId}.${Date.now() - 1000}.${issued.secret}`)
      const expiredRes = await onRequestGet({
        request: new Request(`https://example.com${DEVICE_UNLOCK_PATH}`, {
          headers: { Cookie: `${headers.Cookie}; ${DEVICE_UNLOCK_COOKIE}=${expiredCookie}` },
        }),
        env,
      } as never)
      expect(expiredRes.status).toBe(401)
      expect(expiredRes.headers.get('Set-Cookie')).toContain('Max-Age=0')

      // Revoking the D1 session blocks GET and clears cookie
      db.prepare('UPDATE auth_sessions SET revoked = 1 WHERE id = ?').run(await sessionStorageId(sessionId))
      const revokedRes = await onRequestGet({
        request: new Request(`https://example.com${DEVICE_UNLOCK_PATH}`, {
          headers: { Cookie: `${headers.Cookie}; ${DEVICE_UNLOCK_COOKIE}=${cookieValue}` },
        }),
        env,
      } as never)
      expect(revokedRes.status).toBe(401)
      expect(revokedRes.headers.get('Set-Cookie')).toContain('Max-Age=0')
    } finally { db.close() }
  })

  it('blocks GET when the authenticating passkey credential was deleted', async () => {
    const { env, db, headers, sessionId, userId } = await createPasskeyTestEnv()
    try {
      db.prepare('INSERT INTO passkey_credentials (credential_id, user_id, public_key, counter, transports, prf_salt, wrapped_master_key, created_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?)')
        .run('cred-1', userId, new Uint8Array([1, 2, 3]), '[]', 'salt', 'wrapped', Date.now())
      db.prepare('UPDATE auth_sessions SET credential_id = ? WHERE id = ?').run('cred-1', await sessionStorageId(sessionId))

      const postRes = await onRequestPost({
        request: new Request(`https://example.com${DEVICE_UNLOCK_PATH}`, {
          method: 'POST',
          headers: { ...headers, Origin: 'https://example.com', 'Content-Type': 'application/json' },
          body: JSON.stringify({ days: 1 }),
        }),
        env,
      } as never)
      const cookieValue = extractSetCookieValue(postRes.headers.get('Set-Cookie'), DEVICE_UNLOCK_COOKIE)!

      db.prepare('DELETE FROM passkey_credentials WHERE credential_id = ?').run('cred-1')
      const getRes = await onRequestGet({
        request: new Request(`https://example.com${DEVICE_UNLOCK_PATH}`, {
          headers: { Cookie: `${headers.Cookie}; ${DEVICE_UNLOCK_COOKIE}=${cookieValue}` },
        }),
        env,
      } as never)
      expect(getRes.status).toBe(401)
      expect(getRes.headers.get('Set-Cookie')).toContain('Max-Age=0')
    } finally { db.close() }
  })

  it('preserves the cookie and returns 503 on transient D1 failure during GET', async () => {
    const { env, db, headers } = await createPasskeyTestEnv()
    try {
      const postRes = await onRequestPost({
        request: new Request(`https://example.com${DEVICE_UNLOCK_PATH}`, {
          method: 'POST',
          headers: { ...headers, Origin: 'https://example.com', 'Content-Type': 'application/json' },
          body: JSON.stringify({ days: 1 }),
        }),
        env,
      } as never)
      const cookieValue = extractSetCookieValue(postRes.headers.get('Set-Cookie'), DEVICE_UNLOCK_COOKIE)!

      const failingEnv = {
        ...env,
        AUTH_DB: { prepare: () => { throw new Error('D1 temporarily unavailable') } } as never,
      }
      const getRes = await onRequestGet({
        request: new Request(`https://example.com${DEVICE_UNLOCK_PATH}`, {
          headers: { Cookie: `${headers.Cookie}; ${DEVICE_UNLOCK_COOKIE}=${cookieValue}` },
        }),
        env: failingEnv,
      } as never)
      expect(getRes.status).toBe(503)
      expect(getRes.headers.get('Set-Cookie')).toBeNull()
    } finally { db.close() }
  })

  it('clears the device unlock cookie on DELETE and on logout, omitting Secure on http localhost', async () => {
    const { env, db, headers } = await createPasskeyTestEnv({}, { domain: 'http://localhost:8788' })
    try {
      const delRes = await onRequestDelete({
        request: new Request(`http://localhost:8788${DEVICE_UNLOCK_PATH}`, {
          method: 'DELETE',
          headers: { Origin: 'http://localhost:8788' },
        }),
        env,
      } as never)
      expect(delRes.status).toBe(200)
      const delCookie = delRes.headers.get('Set-Cookie') ?? ''
      expect(delCookie).toContain(`${DEVICE_UNLOCK_COOKIE}=`)
      expect(delCookie).toContain('Max-Age=0')
      expect(delCookie).not.toContain('Secure')

      const logoutRes = await onLogout({
        request: new Request('http://localhost:8788/auth/logout', {
          method: 'POST',
          headers: { ...headers, Origin: 'http://localhost:8788' },
        }),
        env,
      } as never)
      expect(logoutRes.status).toBe(200)
      const setCookies = logoutRes.headers.getSetCookie()
      expect(setCookies.some(c => c.includes('linger_session=') && c.includes('Max-Age=0'))).toBe(true)
      expect(setCookies.some(c => c.includes(`${DEVICE_UNLOCK_COOKIE}=`) && c.includes('Max-Age=0'))).toBe(true)
    } finally { db.close() }
  })
})
