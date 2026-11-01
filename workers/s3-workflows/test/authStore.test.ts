import { env } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanupAuth, consumeOAuthState, saveOAuthState } from '../../../functions/_shared/authStore'
import { createSession, deleteAllSessionsForSub, getSession, invalidateSession, isSessionRevoked, saveSession, SessionRevokedError } from '../../../functions/_shared/session'
import type { Env, SessionData } from '../../../functions/_shared/session'
import { onRequest as middleware } from '../../../functions/api/_middleware'
import { onRequestGet as login } from '../../../functions/auth/login'
import { onRequestGet as callback } from '../../../functions/auth/callback'
import { onRequestGet as checkSession } from '../../../functions/auth/session'
import { onRequestPost as logout } from '../../../functions/auth/logout'
import { verifyGoogleIdToken } from '../../../functions/_shared/google'

vi.mock('../../../functions/_shared/google', () => ({
  verifyGoogleAccessToken: vi.fn(async () => 3600),
  verifyGoogleIdToken: vi.fn(async () => ({ sub: '12345', email: 'person@example.com' })),
}))

afterEach(() => vi.unstubAllGlobals())

const secrets = {
  access_token: 'worker-access-sentinel',
  refresh_token: 'worker-refresh-sentinel',
  id_token: 'worker-id-sentinel',
}

function session(extra: Partial<SessionData> = {}): SessionData {
  return {
    ...secrets,
    expires_at: Date.now() + 3_600_000,
    id_token_verified: true,
    email: 'person@example.com',
    google_sub: '12345',
    client_id: 'client',
    folder_id: 'folder-metadata',
    ...extra,
  }
}

function authEnv(): Env & { AUTH_DB: D1Database } {
  return { ...env, GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', SESSION_DOMAIN: 'https://example.com' }
}

async function account(extra: Partial<SessionData> = {}) {
  const id = crypto.randomUUID()
  const data = session(extra)
  const bindings = authEnv()
  await createSession(id, data, bindings)
  return { id, data, bindings }
}

describe('D1 authentication and metadata-only persistence', () => {
  it('completes popup login, transient session validation, and logout using only D1', async () => {
    const bindings = authEnv()
    const noKv = new Proxy(bindings.SESSIONS, { get() { throw new Error('Unexpected KV access') } })
    const onlyD1 = { ...bindings, SESSIONS: noKv }
    const started = await login({ request: new Request('https://example.com/auth/login'), env: onlyD1 } as never)
    const redirect = new URL(started.headers.get('Location')!)
    const state = redirect.searchParams.get('state')!
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      access_token: secrets.access_token,
      refresh_token: secrets.refresh_token,
      id_token: secrets.id_token,
      expires_in: 3600,
    }))))

    const completed = await callback({ env: onlyD1, request: new Request(`https://example.com/auth/callback?code=code&state=${state}`, {
      headers: { Cookie: `linger_oauth_state=${state}` },
    }) } as never)
    expect(completed.status).toBe(200)
    expect(await completed.text()).toContain('linger-oauth-complete')
    expect(verifyGoogleIdToken).toHaveBeenCalledWith(secrets.id_token, 'client', redirect.searchParams.get('nonce'))
    const id = completed.headers.get('Set-Cookie')!.match(/linger_session=([^;]+)/)![1]

    const request = new Request('https://example.com/auth/session', {
      headers: {
        Cookie: `linger_session=${id}`,
        Authorization: `Bearer ${secrets.access_token}`,
        'X-Linger-Google-ID-Token': secrets.id_token,
      },
    })
    expect(await (await checkSession({ env: onlyD1, request } as never)).json())
      .toMatchObject({ signedIn: true, googleSub: '12345' })
    const row = await bindings.AUTH_DB.prepare('SELECT data FROM auth_sessions WHERE id = ?').bind(id).first<{ data: string }>()
    for (const value of Object.values(secrets)) expect(row!.data).not.toContain(value)

    const ended = await logout({ env: onlyD1, request: new Request('https://example.com/auth/logout', {
      method: 'POST', headers: { Cookie: `linger_session=${id}`, Origin: 'https://example.com', 'X-Linger-Account': 'sub:12345' },
    }) } as never)
    expect(ended.status).toBe(200)
    expect(await (await checkSession({ env: onlyD1, request } as never)).json()).toEqual({ signedIn: false })
  })

  it('renews authenticated D1 sessions without touching KV or persisting bearer credentials', async () => {
    const { id, bindings } = await account({ renewed_at: Date.now() - 86_400_001 })
    const noKv = new Proxy(bindings.SESSIONS, { get() { throw new Error('Unexpected KV access') } })
    const context = {
      env: { ...bindings, SESSIONS: noKv },
      data: {},
      request: new Request('https://example.com/api/drive/entries', {
        headers: {
          Cookie: `linger_session=${id}`,
          Authorization: `Bearer ${secrets.access_token}`,
          'X-Linger-Account': 'sub:12345',
        },
      }),
      next: vi.fn(async () => new Response('ok')),
    }
    await bindings.AUTH_DB.prepare("UPDATE auth_sessions SET data = json_set(data, '$.renewed_at', ?) WHERE id = ?")
      .bind(Date.now() - 86_400_001, id).run()

    expect((await middleware(context as never)).status).toBe(200)
    expect(context.next).toHaveBeenCalledOnce()
    expect((await getSession(id, bindings))!.renewed_at).toBeGreaterThan(Date.now() - 60_000)
    const row = await bindings.AUTH_DB.prepare('SELECT data FROM auth_sessions WHERE id = ?').bind(id).first<{ data: string }>()
    for (const value of Object.values(secrets)) expect(row!.data).not.toContain(value)
  })

  it('keeps OAuth credentials out of D1 through create and stale metadata saves', async () => {
    const { id, bindings, data } = await account({
      s3_settings_file_id: 'cached-settings',
      s3_status_file_id: 'cached-status',
      s3_settings_negative_cache_at: Date.now(),
      s3_status_negative_cache_at: Date.now(),
    })
    data.folder_id = 'updated-folder'
    await saveSession(id, data, bindings)

    const row = await bindings.AUTH_DB.prepare('SELECT data, email, google_sub, client_id FROM auth_sessions WHERE id = ?')
      .bind(id).first<{ data: string; email: string; google_sub: string; client_id: string }>()
    for (const value of Object.values(secrets)) expect(JSON.stringify(row)).not.toContain(value)
    const persisted = JSON.parse(row!.data)
    expect(persisted).toMatchObject({ folder_id: 'updated-folder', google_sub: '12345' })
    expect(persisted).not.toHaveProperty('email')
    expect(row?.email).toBeNull()
    for (const key of ['access_token', 'refresh_token', 'id_token', 'expires_at', 'id_token_verified']) {
      expect(persisted).not.toHaveProperty(key)
    }
    expect(await getSession(id, bindings)).not.toHaveProperty('access_token')
  })

  it('uses the D1 trigger to reject unknown, nested, and wrongly typed session metadata', async () => {
    const id = crypto.randomUUID()
    const bindings = authEnv()
    const insert = (value: unknown) => bindings.AUTH_DB.prepare(
      'INSERT INTO auth_sessions (id, data, expires_at) VALUES (?, ?, ?)',
    ).bind(id, JSON.stringify(value), Date.now() + 60_000).run()

    await expect(insert({ google_sub: '12345', future_secret: 'sentinel' })).rejects.toThrow()
    await expect(insert({ google_sub: '12345', nested: { access_token: 'sentinel' } })).rejects.toThrow()
    await expect(insert({ google_sub: ['12345'] })).rejects.toThrow()
    await insert({ google_sub: '12345', folder_id: 'folder' })
    await expect(bindings.AUTH_DB.prepare('UPDATE auth_sessions SET data = ? WHERE id = ?')
      .bind(JSON.stringify({ google_sub: '12345', unknown: 'sentinel' }), id).run()).rejects.toThrow()
  })

  it('does not import legacy KV sessions even while old cutover flags are present', async () => {
    const bindings = authEnv()
    const id = crypto.randomUUID()
    await bindings.SESSIONS.put(`session:${id}`, JSON.stringify(session()), { expirationTtl: 120 })
    const calls: string[] = []
    const noKv = new Proxy(bindings.SESSIONS, { get(target, property) {
      calls.push(String(property))
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    } })

    expect(await getSession(id, { ...bindings, SESSIONS: noKv, AUTH_KV_FALLBACK_UNTIL: new Date(Date.now() + 60_000).toISOString() })).toBeNull()
    expect(calls).toEqual([])
    expect(await bindings.AUTH_DB.prepare('SELECT id FROM auth_sessions WHERE id = ?').bind(id).first()).toBeNull()
  })

  it('writes an irreversible credential-free D1 tombstone on logout', async () => {
    const { id, bindings, data } = await account()
    await bindings.SESSIONS.put(`session:${id}`, JSON.stringify(session()), { expirationTtl: 120 })
    await invalidateSession(id, data.email, bindings, data.google_sub)
    expect(await getSession(id, bindings)).toBeNull()
    expect(await isSessionRevoked(id, bindings)).toBe(true)
    const row = await bindings.AUTH_DB.prepare('SELECT data, email, google_sub, client_id, revoked, refresh_owner FROM auth_sessions WHERE id = ?')
      .bind(id).first()
    expect(row).toMatchObject({ data: null, email: null, google_sub: null, client_id: null, revoked: 1, refresh_owner: null })
    await expect(saveSession(id, data, bindings)).rejects.toBeInstanceOf(SessionRevokedError)
  })

  it('revokes all D1 sessions by indexed Google subject', async () => {
    const subject = crypto.randomUUID()
    const email = `${subject}@example.com`
    const bindings = authEnv()
    const ids = [crypto.randomUUID(), crypto.randomUUID()]
    for (const id of ids) await createSession(id, session({ email, google_sub: subject }), bindings)

    await deleteAllSessionsForSub(subject, bindings)
    for (const id of ids) {
      expect(await getSession(id, bindings)).toBeNull()
      expect(await isSessionRevoked(id, bindings)).toBe(true)
      expect(await bindings.AUTH_DB.prepare('SELECT data, email, google_sub, client_id FROM auth_sessions WHERE id = ?').bind(id).first())
        .toMatchObject({ data: null, email: null, google_sub: null, client_id: null })
    }
  })

  it('fails closed on D1 read errors instead of falling back to KV credentials', async () => {
    const bindings = authEnv()
    const id = crypto.randomUUID()
    await bindings.SESSIONS.put(`session:${id}`, JSON.stringify(session()), { expirationTtl: 120 })
    const broken = { ...bindings, AUTH_DB: new Proxy(bindings.AUTH_DB, { get() { throw new Error('D1 unavailable') } }) }
    await expect(getSession(id, broken)).rejects.toThrow('D1 unavailable')
  })

  it('consumes OAuth state once under concurrent callbacks and ignores legacy KV state', async () => {
    const bindings = authEnv()
    const state = crypto.randomUUID()
    await saveOAuthState(state, 'verifier', bindings)
    const results = await Promise.all([consumeOAuthState(state, bindings), consumeOAuthState(state, bindings)])
    expect(results.filter(Boolean)).toEqual(['verifier'])

    const legacyState = crypto.randomUUID()
    await bindings.SESSIONS.put(`oauth_state:${legacyState}`, 'legacy-verifier', { expirationTtl: 120 })
    expect(await consumeOAuthState(legacyState, bindings)).toBeNull()
  })

  it('expires D1 sessions and OAuth states and removes both during cleanup', async () => {
    const { id, bindings, data } = await account()
    const state = crypto.randomUUID()
    await saveOAuthState(state, 'verifier', bindings)
    await bindings.AUTH_DB.batch([
      bindings.AUTH_DB.prepare('UPDATE auth_sessions SET expires_at = 0 WHERE id = ?').bind(id),
      bindings.AUTH_DB.prepare('UPDATE auth_oauth_states SET expires_at = 0 WHERE id = ?').bind(state),
    ])
    expect(await getSession(id, bindings)).toBeNull()
    expect(await consumeOAuthState(state, bindings)).toBeNull()
    await cleanupAuth(bindings)
    await expect(saveSession(id, data, bindings)).rejects.toBeInstanceOf(SessionRevokedError)
    expect(await getSession(id, bindings)).toBeNull()
    expect(await bindings.AUTH_DB.prepare('SELECT id FROM auth_oauth_states WHERE id = ?').bind(state).first()).toBeNull()
  })

  it('removes legacy email index keys during scheduled cleanup', async () => {
    const bindings = authEnv()
    const key = `esidx:legacy-${crypto.randomUUID()}@example.com:session`
    await bindings.SESSIONS.put(key, '', { expirationTtl: 120 })
    await cleanupAuth(bindings)
    expect(await bindings.SESSIONS.get(key)).toBeNull()
  })
})
