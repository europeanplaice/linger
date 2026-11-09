import { afterEach, describe, expect, it, vi } from 'vitest'
import { onRequestPost } from '../../functions/auth/refresh'
import { openVaultValue } from '../../functions/_shared/vaultCrypto'
import { createPasskeyTestEnv } from '../helpers/passkeyAuth'
import { revokeD1Account, sessionStorageId } from '../../functions/_shared/authStore'

const mocks = vi.hoisted(() => ({ id: vi.fn(), access: vi.fn() }))
vi.mock('../../functions/_shared/google', () => ({ verifyGoogleIdToken: mocks.id, verifyGoogleAccessToken: mocks.access }))

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('encrypted Google refresh credential', () => {
  it('stores only encrypted credentials, then restores them after passkey unlock', async () => {
    const { env, db, headers, key, userId } = await createPasskeyTestEnv({ google_sub: 'google-user' })
    mocks.id.mockResolvedValue({ sub: 'google-user' })
    mocks.access.mockResolvedValue(3600)
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ access_token: 'access', id_token: 'id', expires_in: 3600 }))))
    const invoke = (body: object) => onRequestPost({ env, request: new Request('https://example.com/auth/refresh', {
      method: 'POST', headers: { ...headers, Origin: 'https://example.com', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }) } as never)
    expect((await invoke({ refreshToken: 'secret-refresh' })).status).toBe(200)
    const row = db.prepare('SELECT envelope FROM google_refresh_vault WHERE user_id = ?').get(userId) as { envelope: string }
    expect(row.envelope).not.toContain('secret-refresh')
    expect(await openVaultValue(key, userId, 'google-refresh-token', row.envelope)).toEqual({ token: 'secret-refresh' })
    const restored = await invoke({})
    expect(restored.status).toBe(200)
    expect(await restored.json()).toMatchObject({ accessToken: 'access', idToken: 'id' })
    db.close()
  })

  it('rejects credentials belonging to a different Google account', async () => {
    const { env, db, headers } = await createPasskeyTestEnv({ google_sub: 'google-user' })
    mocks.id.mockResolvedValue({ sub: 'other-user' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ access_token: 'access', id_token: 'id', expires_in: 3600 }))))
    const request = new Request('https://example.com/auth/refresh', { method: 'POST', headers: { ...headers, Origin: 'https://example.com' }, body: JSON.stringify({ refreshToken: 'secret' }) })
    expect((await onRequestPost({ env, request } as never)).status).toBe(401)
    expect(db.prepare('SELECT COUNT(*) AS n FROM google_refresh_vault').get()).toEqual({ n: 0 })
    db.close()
  })

  it('clears saved credentials when a Google security event revokes sessions', async () => {
    const { env, db, userId } = await createPasskeyTestEnv({ google_sub: 'google-user' })
    db.prepare('INSERT INTO google_refresh_vault (user_id, envelope, updated_at) VALUES (?, ?, ?)').run(userId, 'v1.ciphertext', Date.now())
    await revokeD1Account('google_sub', 'google-user', { ...env, AUTH_DB: env.AUTH_DB! })
    expect(db.prepare('SELECT COUNT(*) AS n FROM google_refresh_vault').get()).toEqual({ n: 0 })
    db.close()
  })

  it('requires Google reconnection when the refresh token is rejected', async () => {
    const { env, db, headers, userId, key } = await createPasskeyTestEnv({ google_sub: 'google-user' })
    const { sealVaultValue } = await import('../../functions/_shared/vaultCrypto')
    const envelope = await sealVaultValue(key, userId, 'google-refresh-token', { token: 'revoked' })
    db.prepare('INSERT INTO google_refresh_vault (user_id, envelope, updated_at) VALUES (?, ?, ?)').run(userId, envelope, Date.now())
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 400 })))
    const request = new Request('https://example.com/auth/refresh', { method: 'POST', headers: { ...headers, Origin: 'https://example.com' }, body: '{}' })
    expect((await onRequestPost({ env, request } as never)).status).toBe(401)
    expect(db.prepare('SELECT envelope FROM google_refresh_vault WHERE user_id = ?').get(userId)).toEqual({ envelope })
    db.close()
  })

  it('rejects refresh attempts without the unlocked account key', async () => {
    const { env, db, headers } = await createPasskeyTestEnv({ google_sub: 'google-user' })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const request = new Request('https://example.com/auth/refresh', {
      method: 'POST', headers: { ...headers, Origin: 'https://example.com', 'X-Linger-Vault-Key': 'A'.repeat(43) }, body: '{}',
    })
    expect((await onRequestPost({ env, request } as never)).status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
    db.close()
  })

  it('does not save credentials when the session is revoked during Google refresh', async () => {
    const { env, db, headers, sessionId } = await createPasskeyTestEnv({ google_sub: 'google-user' })
    mocks.id.mockResolvedValue({ sub: 'google-user' })
    mocks.access.mockResolvedValue(3600)
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      db.prepare('UPDATE auth_sessions SET revoked = 1 WHERE id = ?').run(await sessionStorageId(sessionId))
      return new Response(JSON.stringify({ access_token: 'access', id_token: 'id', expires_in: 3600 }))
    }))
    const request = new Request('https://example.com/auth/refresh', { method: 'POST', headers: { ...headers, Origin: 'https://example.com' }, body: JSON.stringify({ refreshToken: 'secret' }) })
    expect((await onRequestPost({ env, request } as never)).status).toBe(401)
    expect(db.prepare('SELECT COUNT(*) AS n FROM google_refresh_vault').get()).toEqual({ n: 0 })
    db.close()
  })
})
