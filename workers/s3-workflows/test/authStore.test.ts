import { env } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanupAuth, consumeOAuthState, finishD1Refresh, saveOAuthState } from '../../../functions/_shared/authStore'
import { createSession, deleteAllSessionsForEmail, deleteAllSessionsForSub, getRefreshTokenForEmail, getRefreshTokenForSub, getSession, getValidAccessToken, getValidIdToken, invalidateSession, isSessionRevoked, saveSession, SessionRevokedError } from '../../../functions/_shared/session'
import type { Env, SessionData } from '../../../functions/_shared/session'
import { onRequest as middleware } from '../../../functions/api/_middleware'
import { onRequestGet as login } from '../../../functions/auth/login'
import { onRequestGet as callback } from '../../../functions/auth/callback'
import { onRequestGet as checkSession } from '../../../functions/auth/session'
import { onRequestPost as logout } from '../../../functions/auth/logout'
import { verifyGoogleIdToken } from '../../../functions/_shared/google'

vi.mock('../../../functions/_shared/google', () => ({
  verifyGoogleIdToken: vi.fn(async () => ({ sub: '12345', email: 'person@example.com' })),
}))

afterEach(() => vi.unstubAllGlobals())

function session(extra: Partial<SessionData> = {}): SessionData {
  return { access_token: 'old-access', refresh_token: 'refresh', expires_at: Date.now() + 3_600_000,
    email: 'person@example.com', google_sub: '12345', client_id: 'client', ...extra }
}

function authEnv(legacy = false): Env & { AUTH_DB: D1Database } {
  return { ...env, GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', SESSION_DOMAIN: 'https://example.com',
    AUTH_KV_FALLBACK_UNTIL: legacy ? new Date(Date.now() + 3_600_000).toISOString() : '' }
}

async function account(extra: Partial<SessionData> = {}) {
  const id = crypto.randomUUID()
  const data = session(extra)
  const bindings = authEnv()
  await createSession(id, data, bindings)
  return { id, data, bindings }
}

describe('D1 authentication', () => {
  it('completes login, callback, session check, and logout using only D1', async () => {
    const bindings = authEnv()
    const noKv = new Proxy(bindings.SESSIONS, { get() { throw new Error('Unexpected KV access') } })
    const onlyD1 = { ...bindings, SESSIONS: noKv }
    const started = await login({ request: new Request('https://example.com/auth/login'), env: onlyD1 } as never)
    const redirect = new URL(started.headers.get('Location')!)
    const state = redirect.searchParams.get('state')!
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      access_token: 'access', refresh_token: 'refresh', id_token: 'verified-by-test', expires_in: 3600,
    }))))
    const completed = await callback({ env: onlyD1, request: new Request(`https://example.com/auth/callback?code=code&state=${state}`, {
      headers: { Cookie: `linger_oauth_state=${state}` },
    }) } as never)
    expect(completed.status).toBe(302)
    expect(verifyGoogleIdToken).toHaveBeenCalledWith('verified-by-test', 'client', redirect.searchParams.get('nonce'))
    const id = completed.headers.get('Set-Cookie')!.match(/linger_session=([^;]+)/)![1]
    const request = new Request('https://example.com/auth/session', { headers: { Cookie: `linger_session=${id}` } })
    expect(await (await checkSession({ env: onlyD1, request } as never)).json()).toMatchObject({ signedIn: true, googleSub: '12345' })
    const ended = await logout({ env: onlyD1, request: new Request('https://example.com/auth/logout', {
      method: 'POST', headers: { Cookie: `linger_session=${id}`, Origin: 'https://example.com', 'X-Linger-Account': 'sub:12345' },
    }) } as never)
    expect(ended.status).toBe(200)
    expect(await (await checkSession({ env: onlyD1, request } as never)).json()).toEqual({ signedIn: false })
  })

  it('serves normal authenticated requests and renewals without reading or writing KV', async () => {
    const { id, bindings } = await account({ renewed_at: Date.now() - 86_400_001 })
    // A binding that throws on any KV operation proves the normal D1 path is independent.
    const noKv = new Proxy(bindings.SESSIONS, { get() { throw new Error('Unexpected KV access') } })
    const context = {
      env: { ...bindings, SESSIONS: noKv }, data: {},
      request: new Request('https://example.com/api/drive/entries', { headers: { Cookie: `linger_session=${id}`, 'X-Linger-Account': 'sub:12345' } }),
      next: vi.fn(async () => new Response('ok')),
    }
    // createSession stamps the current renewal; deliberately age the persisted row.
    await bindings.AUTH_DB.prepare("UPDATE auth_sessions SET data = json_set(data, '$.renewed_at', ?) WHERE id = ?").bind(Date.now() - 86_400_001, id).run()
    expect((await middleware(context as never)).status).toBe(200)
    expect(context.next).toHaveBeenCalledOnce()
    expect((await getSession(id, bindings))!.renewed_at).toBeGreaterThan(Date.now() - 60_000)
  })

  it('imports a legacy session once without extending its KV lifetime', async () => {
    const bindings = authEnv(true)
    const id = crypto.randomUUID()
    const data = session()
    await bindings.SESSIONS.put(`session:${id}`, JSON.stringify(data), { expirationTtl: 120 })
    const key = (await bindings.SESSIONS.list({ prefix: `session:${id}` })).keys[0]
    expect(await getSession(id, bindings)).toEqual(data)
    expect(await bindings.AUTH_DB.prepare('SELECT expires_at FROM auth_sessions WHERE id = ?').bind(id).first('expires_at')).toBe(key.expiration! * 1000)
    await bindings.SESSIONS.delete(`session:${id}`)
    expect(await getSession(id, bindings)).toEqual(data)
  })

  it('never imports a revoked legacy session or revives a D1 tombstone', async () => {
    const bindings = authEnv(true)
    const id = crypto.randomUUID()
    await bindings.SESSIONS.put(`session:${id}`, JSON.stringify(session()), { expirationTtl: 120 })
    await bindings.SESSIONS.put(`revoked-session:${id}`, '1')
    expect(await getSession(id, bindings)).toBeNull()
    await bindings.SESSIONS.delete(`revoked-session:${id}`)
    expect(await getSession(id, bindings)).toBeNull()
    await expect(saveSession(id, session(), bindings)).rejects.toBeInstanceOf(SessionRevokedError)
  })

  it('keeps a concurrent logout authoritative over an in-flight legacy import', async () => {
    const bindings = authEnv(true)
    const id = crypto.randomUUID()
    await bindings.SESSIONS.put(`session:${id}`, JSON.stringify(session()), { expirationTtl: 120 })
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const reading = new Promise<void>(resolve => { entered = resolve })
    const delayed = new Proxy(bindings.SESSIONS, { get(target, property) {
      if (property === 'get') return async (key: string) => {
        const value = await target.get(key)
        if (key === `session:${id}`) { entered(); await gate }
        return value
      }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    } })
    const imported = getSession(id, { ...bindings, SESSIONS: delayed })
    await reading
    await invalidateSession(id, undefined, bindings)
    release()
    expect(await imported).toBeNull()
    expect(await getSession(id, bindings)).toBeNull()
  })

  it('disables KV fallback after the configured migration deadline', async () => {
    const { bindings } = await account()
    const id = crypto.randomUUID()
    await bindings.SESSIONS.put(`session:${id}`, JSON.stringify(session()), { expirationTtl: 120 })
    expect(await getSession(id, bindings)).toBeNull()
  })

  it('honors logout from an old KV-only deployment during the bounded cutover window', async () => {
    const { id, bindings } = await account()
    const cutover = { ...bindings, AUTH_KV_FALLBACK_UNTIL: new Date(Date.now() + 3_600_000).toISOString(), AUTH_KV_REVOCATION_CHECK_UNTIL: new Date(Date.now() + 60_000).toISOString() }
    await cutover.SESSIONS.put(`revoked-session:${id}`, '1')
    expect(await getSession(id, cutover)).toBeNull()
    expect(await isSessionRevoked(id, bindings)).toBe(true)
  })

  it('stops consulting KV revocation markers once the cutover window ends', async () => {
    const { id, bindings } = await account()
    const cutover = { ...bindings, AUTH_KV_FALLBACK_UNTIL: new Date(Date.now() + 3_600_000).toISOString(), AUTH_KV_REVOCATION_CHECK_UNTIL: new Date(Date.now() - 1).toISOString() }
    const noKv = new Proxy(bindings.SESSIONS, { get() { throw new Error('Unexpected KV access') } })
    expect(await getSession(id, { ...cutover, SESSIONS: noKv })).not.toBeNull()
  })

  it('fails closed on D1 errors instead of authorizing from KV', async () => {
    const bindings = authEnv(true)
    const id = crypto.randomUUID()
    await bindings.SESSIONS.put(`session:${id}`, JSON.stringify(session()), { expirationTtl: 120 })
    const broken = { ...bindings, AUTH_DB: new Proxy(bindings.AUTH_DB, { get() { throw new Error('D1 unavailable') } }) }
    await expect(getSession(id, broken)).rejects.toThrow('D1 unavailable')
  })

  it('finds refresh tokens by indexed identity and checks subject and OAuth client', async () => {
    const sub = crypto.randomUUID()
    const email = `${sub}@example.com`
    const { id, bindings } = await account({ email, google_sub: sub })
    expect(await getRefreshTokenForSub(sub, 'client', bindings)).toBe('refresh')
    expect(await getRefreshTokenForEmail(` ${email.toUpperCase()} `, 'client', bindings, sub)).toBe('refresh')
    expect(await getRefreshTokenForEmail(email, 'client', bindings, 'other-person')).toBeNull()
    expect(await getRefreshTokenForSub(sub, 'retired-client', bindings)).toBeNull()
    await invalidateSession(id, email, bindings, sub)
    expect(await getRefreshTokenForSub(sub, 'client', bindings)).toBeNull()
  })

  it.each(['email', 'sub'] as const)('revokes all D1 sessions through the %s identity', async kind => {
    const subject = crypto.randomUUID()
    const email = `${subject}@example.com`
    const bindings = authEnv()
    const ids = [crypto.randomUUID(), crypto.randomUUID()]
    for (const id of ids) await createSession(id, session({ email, google_sub: subject }), bindings)
    if (kind === 'email') await deleteAllSessionsForEmail(email.toUpperCase(), bindings)
    else await deleteAllSessionsForSub(subject, bindings)
    for (const id of ids) {
      expect(await getSession(id, bindings)).toBeNull()
      expect(await isSessionRevoked(id, bindings)).toBe(true)
      expect(await bindings.AUTH_DB.prepare('SELECT data FROM auth_sessions WHERE id = ?').bind(id).first('data')).toBeNull()
    }
  })

  it('revokes indexed legacy sessions even before their first D1 access', async () => {
    const bindings = authEnv(true)
    const id = crypto.randomUUID()
    const sub = crypto.randomUUID()
    await bindings.SESSIONS.put(`session:${id}`, JSON.stringify(session({ google_sub: sub })), { expirationTtl: 120 })
    await bindings.SESSIONS.put(`ssidx:${sub}:${id}`, '', { expirationTtl: 120 })
    await deleteAllSessionsForSub(sub, bindings)
    expect(await getSession(id, bindings)).toBeNull()
    expect(await bindings.SESSIONS.get(`session:${id}`)).toBeNull()
  })

  it('coordinates refreshes from independent callers through a D1 lease', async () => {
    const { id, bindings } = await account({ expires_at: Date.now() - 60_000 })
    const first = (await getSession(id, bindings))!
    const second = structuredClone(first)
    const fetcher = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 50))
      return new Response(JSON.stringify({ access_token: 'new-access', expires_in: 3600 }))
    })
    vi.stubGlobal('fetch', fetcher)
    expect(await Promise.all([getValidAccessToken(id, first, bindings), getValidAccessToken(id, second, bindings)])).toEqual(['new-access', 'new-access'])
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('does not let a stale metadata save overwrite refreshed tokens or retain a removed ID token', async () => {
    const { id, bindings } = await account({ expires_at: Date.now() - 60_000, id_token: 'old-id', id_token_verified: true })
    const stale = (await getSession(id, bindings))!
    const fresh = structuredClone(stale)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ access_token: 'new-access', expires_in: 3600 }))))
    await getValidAccessToken(id, fresh, bindings)
    stale.folder_id = 'folder'
    await saveSession(id, stale, bindings)
    expect(stale.access_token).toBe('new-access')
    expect(stale.id_token).toBeUndefined()
    expect(await getSession(id, bindings)).toMatchObject({ access_token: 'new-access', folder_id: 'folder' })
  })

  it('refreshes an expired persisted token even when the caller holds an older token', async () => {
    const { id, bindings } = await account({ expires_at: Date.now() - 60_000 })
    const older = session({ access_token: 'even-older-access', expires_at: Date.now() - 3_600_000 })
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ access_token: 'new-access', expires_in: 3600 })))
    vi.stubGlobal('fetch', fetcher)
    expect(await getValidAccessToken(id, older, bindings)).toBe('new-access')
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('releases a failed refresh lease so a subsequent request can recover', async () => {
    const { id, bindings, data } = await account({ expires_at: Date.now() - 60_000 })
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'recovered', expires_in: 3600 })))
    vi.stubGlobal('fetch', fetcher)
    await expect(getValidAccessToken(id, data, bindings)).rejects.toThrow('Token refresh failed')
    expect(await bindings.AUTH_DB.prepare('SELECT refresh_owner FROM auth_sessions WHERE id = ?').bind(id).first('refresh_owner')).toBeNull()
    expect(await getValidAccessToken(id, data, bindings)).toBe('recovered')
  })

  it('does not duplicate forced refreshes even when Google returns the same access token', async () => {
    const { id, bindings } = await account()
    const first = (await getSession(id, bindings))!
    const second = structuredClone(first)
    const fetcher = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
      return new Response(JSON.stringify({ access_token: first.access_token, expires_in: 7200 }))
    })
    vi.stubGlobal('fetch', fetcher)
    expect(await Promise.all([getValidIdToken(id, first, bindings), getValidIdToken(id, second, bindings)])).toEqual([null, null])
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('prevents an in-flight token refresh from recreating a logged-out session', async () => {
    const { id, bindings, data } = await account({ expires_at: Date.now() - 60_000 })
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const fetching = new Promise<void>(resolve => { entered = resolve })
    vi.stubGlobal('fetch', vi.fn(async () => {
      entered(); await gate
      return new Response(JSON.stringify({ access_token: 'late-token', expires_in: 3600 }))
    }))
    const pending = getValidAccessToken(id, data, bindings)
    const rejected = expect(pending).rejects.toBeInstanceOf(SessionRevokedError)
    await fetching
    await invalidateSession(id, data.email, bindings, data.google_sub)
    release()
    await rejected
    expect(await getSession(id, bindings)).toBeNull()
    await expect(saveSession(id, data, bindings)).rejects.toBeInstanceOf(SessionRevokedError)
  })

  it('rejects a refresh completion from a superseded lease owner', async () => {
    const { id, bindings } = await account()
    await bindings.AUTH_DB.prepare('UPDATE auth_sessions SET refresh_owner = ? WHERE id = ?').bind('new-owner', id).run()
    await expect(finishD1Refresh(id, session({ access_token: 'stale-token' }), 'old-owner', bindings)).rejects.toThrow('lease lost')
    expect((await getSession(id, bindings))!.access_token).toBe('old-access')
  })

  it('consumes OAuth state exactly once under concurrent callbacks', async () => {
    const bindings = authEnv()
    const state = crypto.randomUUID()
    await saveOAuthState(state, 'verifier', bindings)
    const results = await Promise.all([consumeOAuthState(state, bindings), consumeOAuthState(state, bindings)])
    expect(results.filter(Boolean)).toEqual(['verifier'])
  })

  it('consumes a legacy OAuth state once without replaying the remaining KV value', async () => {
    const bindings = authEnv(true)
    const state = crypto.randomUUID()
    await bindings.SESSIONS.put(`oauth_state:${state}`, 'verifier', { expirationTtl: 120 })
    expect(await consumeOAuthState(state, bindings)).toBe('verifier')
    expect(await consumeOAuthState(state, bindings)).toBeNull()
  })

  it('rejects expired sessions/states and cleans them up without reviving stale updates', async () => {
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
  })
})
