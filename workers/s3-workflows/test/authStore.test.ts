import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { sessionStorageId, durableSessionHandle } from '../../../functions/_shared/authStore'
import { getSession, getSessionByStorageId, invalidateSession, saveSession } from '../../../functions/_shared/session'
import { createTestSession, testSession } from './auth'

describe('encrypted passkey session storage', () => {
  it('stores only the random principal and encrypted account metadata in D1', async () => {
    const userId = `user-${crypto.randomUUID()}`
    const sessionId = `session-${crypto.randomUUID()}`
    const key = testSession(userId).vault_key!
    const googleSub = `google-sub-${crypto.randomUUID()}`
    const session = testSession(userId, {
      vault_key: key,
      google_sub: googleSub,
      folder_id: 'drive-folder-sensitive',
      s3_settings_file_id: 'drive-settings-sensitive',
      access_token: 'access-token-sensitive',
      refresh_token: 'refresh-token-sensitive',
      id_token: 'id-token-sensitive',
      email: 'person@example.com',
    })
    await createTestSession(sessionId, session, env)

    const storageId = await sessionStorageId(sessionId)
    const sessionRow = await env.AUTH_DB.prepare('SELECT id, user_id, data FROM auth_sessions WHERE id = ?')
      .bind(storageId).first<Record<string, unknown>>()
    const profileRow = await env.AUTH_DB.prepare('SELECT account_envelope FROM passkey_users WHERE id = ?')
      .bind(userId).first<{ account_envelope: string }>()
    const persisted = JSON.stringify({ sessionRow, profileRow })
    expect(sessionRow).toMatchObject({ id: storageId, user_id: userId, data: null })
    expect(profileRow!.account_envelope).toMatch(/^v1\./)
    for (const secret of [sessionId, googleSub, session.email, session.folder_id, session.s3_settings_file_id,
      session.access_token, session.refresh_token, session.id_token, key]) {
      expect(persisted).not.toContain(secret)
    }
    expect(await getSession(sessionId, env)).toBeNull()
    expect(await getSession(sessionId, env, key)).toMatchObject({ user_id: userId, google_sub: googleSub, folder_id: session.folder_id })
    expect(await getSessionByStorageId(storageId, env, key)).toMatchObject({ user_id: userId, google_sub: googleSub })
  })

  it('merges encrypted metadata updates and fails closed when the key is absent', async () => {
    const userId = `user-${crypto.randomUUID()}`
    const sessionId = `session-${crypto.randomUUID()}`
    const session = testSession(userId, { folder_id: 'before-folder' })
    await createTestSession(sessionId, session, env)
    const { vault_key: _key, ...locked } = session
    await expect(saveSession(sessionId, { ...locked, folder_id: 'forged' }, env)).rejects.toThrow()

    const loaded = (await getSession(sessionId, env, session.vault_key))!
    loaded.folder_id = 'after-folder-sensitive'
    await saveSession(sessionId, loaded, env)
    expect(await getSession(sessionId, env, session.vault_key)).toMatchObject({ folder_id: 'after-folder-sensitive' })
    const profile = await env.AUTH_DB.prepare('SELECT account_envelope FROM passkey_users WHERE id = ?')
      .bind(userId).first<{ account_envelope: string }>()
    expect(profile!.account_envelope).not.toContain('after-folder-sensitive')
  })

  it('never treats a durable session hash as a cookie session and revokes the principal on logout', async () => {
    const userId = `user-${crypto.randomUUID()}`
    const sessionId = `session-${crypto.randomUUID()}`
    const session = testSession(userId)
    await createTestSession(sessionId, session, env)
    const digest = await sessionStorageId(sessionId)
    expect(await durableSessionHandle(sessionId, env)).toBe(digest)
    expect(await getSession(digest, env, session.vault_key)).toBeNull()
    expect(await getSessionByStorageId(digest, env, session.vault_key)).not.toBeNull()

    await invalidateSession(sessionId, undefined, env)
    expect(await getSession(sessionId, env, session.vault_key)).toBeNull()
    expect(await env.AUTH_DB.prepare('SELECT user_id, revoked FROM auth_sessions WHERE id = ?')
      .bind(digest).first()).toMatchObject({ user_id: null, revoked: 1 })
  })
})
