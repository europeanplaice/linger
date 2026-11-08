import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import {
  createPasskeySession,
  durableSessionHandle,
  getPasskeySessionUserId,
  readD1Session,
  readD1SessionByStorageId,
  sessionStorageId,
} from '../../../functions/_shared/authStore'
import { getSession, getSessionByStorageId, invalidateSession, saveSession } from '../../../functions/_shared/session'
import { createTestSession, testSession } from './auth'
import { deleteCredential, listCredentials } from '../../../functions/_shared/passkeys'

const wrappedMasterKey = btoa(String.fromCharCode(...new Uint8Array(60)))
const prfSalt = btoa(String.fromCharCode(...new Uint8Array(32)))

async function insertCredential(userId: string, credentialId: string): Promise<void> {
  await env.AUTH_DB.prepare(`INSERT INTO passkey_credentials
    (credential_id, user_id, public_key, counter, transports, prf_salt, wrapped_master_key, created_at)
    VALUES (?, ?, ?, 1, '[]', ?, ?, ?)`)
    .bind(credentialId, userId, new Uint8Array([1, 2, 3]), prfSalt, wrappedMasterKey, Date.now()).run()
}

async function bindCredential(sessionId: string, credentialId: string): Promise<void> {
  await env.AUTH_DB.prepare('UPDATE auth_sessions SET credential_id = ? WHERE id = ?')
    .bind(credentialId, await sessionStorageId(sessionId)).run()
}

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

  it('rejects a deleted credential in cookie and durable session reads, including a late session from a login race', async () => {
    const userId = `user-${crypto.randomUUID()}`
    const credentialId = `credential-${crypto.randomUUID()}`
    const sessionId = `session-${crypto.randomUUID()}`
    const session = testSession(userId)
    await createTestSession(sessionId, session, env)
    await insertCredential(userId, credentialId)
    await bindCredential(sessionId, credentialId)
    const storageId = await sessionStorageId(sessionId)
    expect(await getPasskeySessionUserId(sessionId, env)).toBe(userId)
    expect(await readD1Session(sessionId, env, session.vault_key)).toMatchObject({ user_id: userId })
    expect(await readD1SessionByStorageId(storageId, env, session.vault_key)).toMatchObject({ user_id: userId })

    await env.AUTH_DB.prepare('DELETE FROM passkey_credentials WHERE credential_id = ?').bind(credentialId).run()
    expect(await getPasskeySessionUserId(sessionId, env)).toBeNull()
    expect(await readD1Session(sessionId, env, session.vault_key)).toBeNull()
    expect(await readD1SessionByStorageId(storageId, env, session.vault_key)).toBeNull()

    // Models login verification finishing after a concurrent delete: the late
    // session can be inserted, but credential-existence checks keep it unusable.
    const lateSessionId = `session-${crypto.randomUUID()}`
    await createPasskeySession(lateSessionId, userId, env, credentialId)
    expect(await getPasskeySessionUserId(lateSessionId, env)).toBeNull()
    expect(await readD1Session(lateSessionId, env, session.vault_key)).toBeNull()
  })

  it('lists and atomically deletes credentials through D1, protecting current and final credentials', async () => {
    const userId = `user-${crypto.randomUUID()}`
    const currentId = `credential-current-${crypto.randomUUID()}`
    const removableId = `credential-other-${crypto.randomUUID()}`
    const currentSessionId = `session-current-${crypto.randomUUID()}`
    const otherSessionId = `session-other-${crypto.randomUUID()}`
    const key = testSession(userId).vault_key!
    const googleSub = `google-sub-${crypto.randomUUID()}`
    const currentSession = testSession(userId, { vault_key: key, google_sub: googleSub })
    const otherSession = testSession(userId, { vault_key: key, google_sub: googleSub })
    await createTestSession(currentSessionId, currentSession, env)
    await createTestSession(otherSessionId, otherSession, env)
    await insertCredential(userId, currentId)
    await insertCredential(userId, removableId)
    await bindCredential(currentSessionId, currentId)
    await bindCredential(otherSessionId, removableId)

    const origin = 'https://example.com'
    const handlerEnv = { AUTH_DB: env.AUTH_DB, SESSION_DOMAIN: origin } as typeof env
    const headers = {
      Origin: origin,
      Cookie: `linger_session=${currentSessionId}`,
      'Content-Type': 'application/json',
      'X-Linger-Vault-Key': key,
      'X-Linger-Vault-User': userId,
    }
    const makeRequest = (path: string, body?: unknown, initHeaders: HeadersInit = headers) => new Request(`${origin}${path}`, {
      method: 'POST', headers: initHeaders, body: body === undefined ? undefined : JSON.stringify(body),
    })

    const listed = await listCredentials(makeRequest('/auth/passkey/credentials/list'), handlerEnv)
    expect(listed.status).toBe(200)
    const listBody = await listed.json() as { credentials: Array<{ credentialId: string; createdAt: number }>; currentCredentialId: string | null }
    expect(listBody.currentCredentialId).toBe(currentId)
    expect(listBody.credentials.map(item => item.credentialId).sort()).toEqual([currentId, removableId].sort())

    const forbidden = await deleteCredential(makeRequest('/auth/passkey/credentials/delete', { credentialId: removableId }, {
      ...headers, Origin: 'https://attacker.example',
    }), handlerEnv)
    expect(forbidden.status).toBe(403)
    const currentDelete = await deleteCredential(makeRequest('/auth/passkey/credentials/delete', { credentialId: currentId }), handlerEnv)
    expect(currentDelete.status).toBe(409)

    const deleted = await deleteCredential(makeRequest('/auth/passkey/credentials/delete', { credentialId: removableId }), handlerEnv)
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toEqual({ ok: true })
    expect(await getPasskeySessionUserId(otherSessionId, env)).toBeNull()
    expect(await readD1Session(otherSessionId, env, key)).toBeNull()
    expect(await env.AUTH_DB.prepare('SELECT user_id, credential_id, revoked FROM auth_sessions WHERE id = ?')
      .bind(await sessionStorageId(otherSessionId)).first()).toMatchObject({ user_id: null, credential_id: null, revoked: 1 })

    // A legacy helper session exercises the SQL guard for a last-credential
    // attempt independently of the current-credential protection above.
    const legacySessionId = `session-legacy-${crypto.randomUUID()}`
    await createTestSession(legacySessionId, testSession(userId, { vault_key: key, google_sub: googleSub }), env)
    const lastDelete = await deleteCredential(makeRequest('/auth/passkey/credentials/delete', { credentialId: currentId }, {
      ...headers, Cookie: `linger_session=${legacySessionId}`,
    }), handlerEnv)
    expect(lastDelete.status).toBe(409)
    expect(await env.AUTH_DB.prepare('SELECT COUNT(*) AS count FROM passkey_credentials WHERE user_id = ?')
      .bind(userId).first()).toMatchObject({ count: 1 })
  })
})
