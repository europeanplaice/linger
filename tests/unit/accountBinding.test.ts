import { describe, expect, it, vi } from 'vitest'
import { onRequest as middleware } from '../../functions/api/_middleware'
import { onRequestPost as logout } from '../../functions/auth/logout'
import { createFakeKV } from '../helpers/fakeKV'

function context(path: string, method: string, account?: string) {
  const session = { google_sub: 'account-B', email: 'b@example.com', access_token: 'b-token', refresh_token: 'r', expires_at: Date.now() + 3_600_000, renewed_at: Date.now() }
  const kv = createFakeKV({ 'session:B': JSON.stringify(session) })
  const headers = new Headers({ Cookie: 'linger_session=B', Origin: 'https://example.com' })
  if (account !== undefined) headers.set('X-Linger-Account', account)
  return {
    request: new Request(`https://example.com${path}`, { method, headers }),
    env: { SESSIONS: kv, SESSION_DOMAIN: 'https://example.com' },
    data: {}, next: vi.fn(async () => new Response('{}')), kv,
  }
}

describe('account binding before private handlers', () => {
  it.each([
    ['GET', '/api/drive/entries'], ['POST', '/api/drive/entry/2026-05-01'],
    ['DELETE', '/api/drive/entry/2026-05-01'], ['PUT', '/api/drive/milestones'],
    ['PUT', '/api/s3/settings'], ['POST', '/api/s3/restore'],
  ])('rejects account A intent with account B cookies for %s %s', async (method, path) => {
    const ctx = context(path, method, 'sub:account-A')
    const response = await middleware(ctx as never)
    expect(response.status).toBe(401)
    expect(response.headers.get('X-Linger-Account-Changed')).toBe('1')
    expect(response.headers.get('Set-Cookie')).toBeNull()
    expect(ctx.next).not.toHaveBeenCalled()
    expect(ctx.kv.has('session:B')).toBe(true)
  })

  it('fails closed for an older client that omits the account binding', async () => {
    const ctx = context('/api/drive/entry/2026-05-01', 'POST')
    expect((await middleware(ctx as never)).status).toBe(401)
    expect(ctx.next).not.toHaveBeenCalled()
  })

  it('allows the account that actually owns the session', async () => {
    const ctx = context('/api/drive/entries', 'GET', 'sub:account-B')
    expect((await middleware(ctx as never)).status).toBe(200)
    expect(ctx.next).toHaveBeenCalledOnce()
  })

  it('prevents an old tab from logging the new account out', async () => {
    const ctx = context('/auth/logout', 'POST', 'sub:account-A')
    const response = await logout(ctx as never)
    expect(response.status).toBe(401)
    expect(response.headers.get('Set-Cookie')).toBeNull()
    expect(ctx.kv.has('session:B')).toBe(true)
    expect(ctx.kv.has('revoked-session:B')).toBe(false)
  })

  it('does not erase an unreadable new session during logout from an old tab', async () => {
    const ctx = context('/auth/logout', 'POST', 'sub:account-A')
    const env = { ...ctx.env, SESSIONS: { ...ctx.kv, get: async () => null } }
    const response = await logout({ ...ctx, env } as never)
    expect(response.status).toBe(200)
    expect(response.headers.get('Set-Cookie')).toBeNull()
    expect(ctx.kv.has('session:B')).toBe(true)
    expect(ctx.kv.has('revoked-session:B')).toBe(false)
  })
})
