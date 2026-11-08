import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { onRequest as middleware } from '../../functions/api/_middleware'
import { onRequestPost as logout } from '../../functions/auth/logout'
import { createPasskeyTestEnv } from '../helpers/passkeyAuth'
import { getPasskeySessionUserId } from '../../functions/_shared/authStore'

async function context(path: string, method: string, account?: string) {
  const session = { google_sub: 'account-B', email: 'b@example.com', renewed_at: Date.now() }
  const { env, headers: vaultHeaders } = await createPasskeyTestEnv(session, { sessionId: 'B' })
  const headers = new Headers({ ...vaultHeaders, Cookie: 'linger_session=B', Origin: 'https://example.com', Authorization: 'Bearer b-token' })
  if (account !== undefined) headers.set('X-Linger-Account', account)
  else headers.delete('X-Linger-Account')
  return {
    request: new Request(`https://example.com${path}`, { method, headers }),
    env,
    data: {}, next: vi.fn(async () => new Response('{}')),
  }
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
    aud: 'client-id', sub: 'account-B', expires_in: 3600,
    scope: 'https://www.googleapis.com/auth/drive.file',
  }), { status: 200 })))
})
afterEach(() => vi.unstubAllGlobals())

describe('account binding before private handlers', () => {
  it.each([
    ['GET', '/api/drive/entries'], ['POST', '/api/drive/entry/2026-05-01'],
    ['DELETE', '/api/drive/entry/2026-05-01'], ['PUT', '/api/drive/milestones'],
    ['PUT', '/api/s3/settings'], ['POST', '/api/s3/restore'],
  ])('rejects account A intent with account B cookies for %s %s', async (method, path) => {
    const ctx = await context(path, method, 'sub:account-A')
    const response = await middleware(ctx as never)
    expect(response.status).toBe(401)
    expect(response.headers.get('X-Linger-Account-Changed')).toBe('1')
    expect(response.headers.get('Set-Cookie')).toBeNull()
    expect(ctx.next).not.toHaveBeenCalled()
    expect(await getPasskeySessionUserId('B', ctx.env)).toBeTruthy()
  })

  it('fails closed for an older client that omits the account binding', async () => {
    const ctx = await context('/api/drive/entry/2026-05-01', 'POST')
    expect((await middleware(ctx as never)).status).toBe(401)
    expect(ctx.next).not.toHaveBeenCalled()
  })

  it('allows the account that actually owns the session', async () => {
    const ctx = await context('/api/drive/entries', 'GET', 'sub:account-B')
    expect((await middleware(ctx as never)).status).toBe(200)
    expect(ctx.next).toHaveBeenCalledOnce()
  })

  it('prevents an old tab from logging the new account out', async () => {
    const ctx = await context('/auth/logout', 'POST', 'sub:account-A')
    const response = await logout(ctx as never)
    expect(response.status).toBe(401)
    expect(response.headers.get('Set-Cookie')).toBeNull()
    expect(await getPasskeySessionUserId('B', ctx.env)).toBeTruthy()
    expect(await getPasskeySessionUserId('B', ctx.env)).toBeTruthy()
  })

  it('does not erase an unreadable new session during logout from an old tab', async () => {
    const ctx = await context('/auth/logout', 'POST', 'sub:account-A')
    const env = { ...ctx.env, AUTH_DB: undefined }
    const response = await logout({ ...ctx, env } as never)
    expect(response.status).toBe(200)
    expect(response.headers.get('Set-Cookie')).toBeNull()
    expect(await getPasskeySessionUserId('B', ctx.env)).toBeTruthy()
    expect(await getPasskeySessionUserId('B', ctx.env)).toBeTruthy()
  })
})
