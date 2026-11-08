import { createPasskeyTestEnv } from '../helpers/passkeyAuth'
import { getSession } from '../../functions/_shared/session'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { onRequest } from '../../functions/api/_middleware'

function makeSession(overrides: Record<string, unknown> = {}) {
  return { google_sub: 'account-a', email: 'a@example.com', renewed_at: Date.now(), folder_id: 'folder-a', ...overrides }
}

const accessTokenInfo = {
  aud: 'id', sub: 'account-a', expires_in: 3600,
  scope: 'openid email https://www.googleapis.com/auth/drive.file',
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(accessTokenInfo), { status: 200 })))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('API auth middleware', () => {
  async function makeContext(overrides: Record<string, any> = {}) {
    const session = overrides.session ?? makeSession()
    const seeded = await createPasskeyTestEnv(session, { clientId: 'id' })
    const baseEnv = {
      ...seeded.env,
      SESSIONS: { get: vi.fn().mockResolvedValue(JSON.stringify(session)), put: vi.fn(), delete: vi.fn() },
      GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret', SESSION_DOMAIN: 'https://example.com',
    }
    const { env: envOverride, ...rest } = overrides
    const headers = new Headers({
      ...seeded.headers, Cookie: 'linger_session=sid123', 'X-Linger-Account': 'sub:account-a', Authorization: 'Bearer at',
    })
    return {
      request: new Request('https://example.com/api/drive/entries', { headers }),
      data: {} as Record<string, unknown>, next: vi.fn().mockResolvedValue(new Response('ok')),
      ...rest,
      env: { ...baseEnv, ...envOverride },
    }
  }

  it('returns 401 when no session cookie', async () => {
    const ctx = await makeContext({ request: new Request('https://example.com/api/drive/entries', { headers: { Authorization: 'Bearer at' } }) })
    expect((await onRequest(ctx as any)).status).toBe(401)
    expect(ctx.next).not.toHaveBeenCalled()
  })

  it('rejects cross-site mutation requests before resolving the session', async () => {
    const ctx = await makeContext({ request: new Request('https://example.com/api/drive/entry/2026-05-01', {
      method: 'POST', headers: {
        Cookie: 'linger_session=sid123', 'X-Linger-Account': 'sub:account-a', Authorization: 'Bearer at',
        Origin: 'https://attacker.example', 'Sec-Fetch-Site': 'cross-site',
      },
    }) })
    expect((await onRequest(ctx as any)).status).toBe(403)
    expect(ctx.next).not.toHaveBeenCalled()
    expect(ctx.env.SESSIONS.get).not.toHaveBeenCalled()
  })

  it('returns 401 when session metadata is absent', async () => {
    const ctx = await makeContext({ env: { AUTH_DB: undefined } })
    expect((await onRequest(ctx as any)).status).toBe(401)
    expect(ctx.next).not.toHaveBeenCalled()
  })

  it('requires a request-scoped bearer token and does not call the handler without one', async () => {
    const ctx = await makeContext({ request: new Request('https://example.com/api/drive/entries', {
      headers: { Cookie: 'linger_session=sid123', 'X-Linger-Account': 'sub:account-a' },
    }) })
    const response = await onRequest(ctx as any)
    expect(response.status).toBe(401)
    expect(ctx.next).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['wrong account', { ...accessTokenInfo, sub: 'account-b' }],
    ['wrong client', { ...accessTokenInfo, aud: 'other-client' }],
    ['missing Drive scope', { ...accessTokenInfo, scope: 'openid email' }],
    ['expired', { ...accessTokenInfo, expires_in: 0 }],
  ])('rejects an access token with %s', async (_reason, info) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(info), { status: 200 })))
    const ctx = await makeContext()
    const response = await onRequest(ctx as any)
    expect(response.status).toBe(401)
    expect(ctx.next).not.toHaveBeenCalled()
  })

  it('returns 503 when Google tokeninfo is temporarily unavailable without revoking the session', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 })))
    const del = vi.fn()
    const ctx = await makeContext({ env: { SESSIONS: { get: vi.fn().mockResolvedValue(JSON.stringify(makeSession())), put: vi.fn(), delete: del } } })
    const response = await onRequest(ctx as any)
    expect(response.status).toBe(503)
    expect(response.headers.get('Retry-After')).toBe('1')
    expect(ctx.next).not.toHaveBeenCalled()
    expect(del).not.toHaveBeenCalled()
  })

  it('passes the validated request token to the handler without persisting credentials', async () => {
    const put = vi.fn()
    const session = makeSession({ renewed_at: Date.now() })
    const ctx = await makeContext({ session, env: { SESSIONS: { get: vi.fn().mockResolvedValue(JSON.stringify(session)), put } } })
    const response = await onRequest(ctx as any)
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(ctx.data.sessionId).toBe('sid123')
    expect(ctx.data.accessToken).toBe('at')
    expect(ctx.data.session).toMatchObject({ google_sub: 'account-a', access_token: 'at' })
    expect(ctx.next).toHaveBeenCalledOnce()
    expect(put).not.toHaveBeenCalled()
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=2592000')
  })

  it('saves renewal metadata without request credentials when the sliding TTL renews', async () => {
    const put = vi.fn()
    const session = makeSession({ renewed_at: Date.now() - 25 * 60 * 60 * 1000 })
    const ctx = await makeContext({ session, env: { SESSIONS: { get: vi.fn().mockResolvedValue(JSON.stringify(session)), put } } })
    await onRequest(ctx as any)
    expect(put).not.toHaveBeenCalled()
    const saved = await getSession('sid123', ctx.env, ctx.request.headers.get('X-Linger-Vault-Key') ?? undefined)
    expect(saved).toMatchObject({ google_sub: 'account-a', folder_id: 'folder-a' })
    expect(saved).not.toHaveProperty('email')
    expect(saved).not.toHaveProperty('access_token')
    expect(saved).not.toHaveProperty('id_token')
  })

  it('sets deploy version when configured', async () => {
    const ctx = await makeContext({ env: { CF_PAGES_COMMIT_SHA: 'abc1234' } })
    expect((await onRequest(ctx as any)).headers.get('X-Deploy-Version')).toBe('abc1234')
  })
})
