// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createPasskeyTestEnv } from '../helpers/passkeyAuth'
import { getSession, saveSession } from '../../functions/_shared/session'
import { getPasskeySessionUserId, revokeD1Account, revokeD1Session, sessionStorageId } from '../../functions/_shared/authStore'
import { encodeVaultBytes } from '../../functions/_shared/vaultCrypto'

describe('encrypted account metadata and opaque passkey sessions', () => {
  it('requires the user key to read metadata and never persists credentials', async () => {
    const { env, db, key, userId, sessionId } = await createPasskeyTestEnv({ google_sub: 'sensitive-sub', folder_id: 'sensitive-folder' })
    try {
      expect(await getSession(sessionId, env)).toBeNull()
      const wrongKey = encodeVaultBytes(crypto.getRandomValues(new Uint8Array(32)))
      expect(await getSession(sessionId, env, wrongKey)).toBeNull()
      const session = (await getSession(sessionId, env, key))!
      expect(session).toMatchObject({ user_id: userId, google_sub: 'sensitive-sub', folder_id: 'sensitive-folder' })
      Object.assign(session, { access_token: 'sensitive-access', id_token: 'sensitive-id', email: 'sensitive@example.com' })
      await saveSession(sessionId, session, env)
      const persisted = JSON.stringify({
        sessions: db.prepare('SELECT * FROM auth_sessions').all(),
        accounts: db.prepare('SELECT * FROM passkey_users').all(),
      })
      for (const secret of [key, 'sensitive-sub', 'sensitive-folder', 'sensitive-access', 'sensitive-id', 'sensitive@example.com', sessionId]) {
        expect(persisted).not.toContain(secret)
      }
      expect(db.prepare('SELECT data FROM auth_sessions').get()).toMatchObject({ data: null })
      const columns = db.prepare('PRAGMA table_info(auth_sessions)').all().map(row => row.name)
      expect(columns).not.toContain('google_sub')
      expect(columns).not.toContain('email')
    } finally { db.close() }
  })

  it('does not accept a stored session digest as a browser cookie', async () => {
    const { env, db, key, sessionId } = await createPasskeyTestEnv({ google_sub: 'sub-a' })
    try {
      const digest = await sessionStorageId(sessionId)
      expect(await getPasskeySessionUserId(sessionId, env)).toBeTruthy()
      expect(await getPasskeySessionUserId(digest, env)).toBeNull()
      expect(await getSession(digest, env, key)).toBeNull()
    } finally { db.close() }
  })

  it('merges changes from independent requests without losing profile fields', async () => {
    const { env, db, key, sessionId } = await createPasskeyTestEnv({ google_sub: 'sub-a', folder_id: 'folder-a' })
    try {
      const first = (await getSession(sessionId, env, key))!
      const second = (await getSession(sessionId, env, key))!
      first.s3_settings_file_id = 'settings-file'
      second.changes_start_page_token = 'changes-token'
      await saveSession(sessionId, first, env)
      await saveSession(sessionId, second, env)
      expect(await getSession(sessionId, env, key)).toMatchObject({
        google_sub: 'sub-a', folder_id: 'folder-a', s3_settings_file_id: 'settings-file', changes_start_page_token: 'changes-token',
      })
      second.google_sub = 'sub-b'
      await expect(saveSession(sessionId, second, env)).rejects.toThrow('Google account changed')
    } finally { db.close() }
  })

  it('rejects a late write after revocation and does not recreate the session', async () => {
    const { env, db, key, sessionId } = await createPasskeyTestEnv({ google_sub: 'sub-a' })
    try {
      const session = (await getSession(sessionId, env, key))!
      await revokeD1Session(sessionId, { ...env, AUTH_DB: env.AUTH_DB! })
      session.folder_id = 'late-folder'
      await expect(saveSession(sessionId, session, env)).rejects.toThrow()
      expect(await getSession(sessionId, env, key)).toBeNull()
      expect(db.prepare('SELECT revoked, user_id FROM auth_sessions').get()).toMatchObject({ revoked: 1, user_id: null })
    } finally { db.close() }
  })

  it('fails closed without D1 and refuses plaintext session payloads at SQL level', async () => {
    const { env, db, sessionId } = await createPasskeyTestEnv()
    try {
      expect(await getSession(sessionId, { ...env, AUTH_DB: undefined })).toBeNull()
      expect(() => db.prepare('UPDATE auth_sessions SET data = ?').run('{"google_sub":"raw"}')).toThrow()
      expect(() => db.prepare('INSERT INTO auth_sessions (id, data, expires_at) VALUES (?, ?, ?)').run('raw', '{}', Date.now() + 1000)).toThrow()
    } finally { db.close() }
  })

  it('handles security events without retaining a Google-sub lookup index', async () => {
    const { env, db, sessionId } = await createPasskeyTestEnv({ google_sub: 'sub-a' })
    try {
      await revokeD1Account('google_sub', 'sub-a', { ...env, AUTH_DB: env.AUTH_DB! })
      expect(await getPasskeySessionUserId(sessionId, env)).toBeNull()
      const indexes = JSON.stringify(db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index'").all())
      expect(indexes).not.toContain('auth_sessions_sub')
    } finally { db.close() }
  })

  it('uses a keyed blind index for targeted revocation when RISC_INDEX_PEPPER is configured', async () => {
    const pepper = 'test-risc-pepper-value-at-least-32-chars'
    const envA = await createPasskeyTestEnv({ google_sub: 'sub-a' }, { userId: 'user-a', sessionId: 'session-a' })
    try {
      const db = envA.db
      const authDb = envA.env.AUTH_DB!
      const envWithPepper = { ...envA.env, AUTH_DB: authDb, RISC_INDEX_PEPPER: pepper }

      // Re-save user-a with pepper so risc_subject_hash is populated, and reject plaintext writes.
      const sessionA = (await getSession('session-a', envWithPepper, envA.key))!
      sessionA.folder_id = 'folder-a'
      await saveSession('session-a', sessionA, envWithPepper)

      const userB = 'user-b'
      const sessionBId = 'session-b'
      const keyB = encodeVaultBytes(crypto.getRandomValues(new Uint8Array(32)))
      const { createPasskeySession, saveD1Session } = await import('../../functions/_shared/authStore')
      db.prepare('INSERT INTO passkey_users (id, created_at) VALUES (?, ?)').run(userB, Date.now())
      await createPasskeySession(sessionBId, userB, envWithPepper)
      await saveD1Session(sessionBId, { user_id: userB, vault_key: keyB, google_sub: 'sub-b' }, { ...envWithPepper, AUTH_DB: authDb })

      const legacyUser = 'user-legacy'
      const legacySessionId = 'session-legacy'
      db.prepare('INSERT INTO passkey_users (id, created_at) VALUES (?, ?)').run(legacyUser, Date.now())
      await createPasskeySession(legacySessionId, legacyUser, envWithPepper)

      const userARow = db.prepare('SELECT risc_subject_hash FROM passkey_users WHERE id = ?').get('user-a') as { risc_subject_hash: string }
      expect(userARow.risc_subject_hash).toMatch(/^hmac-sha256:[0-9a-f]{64}$/)
      expect(userARow.risc_subject_hash).not.toContain('sub-a')
      expect(() => db.prepare('UPDATE passkey_users SET risc_subject_hash = ? WHERE id = ?').run('sub-a', 'user-a')).toThrow()

      await revokeD1Account('google_sub', 'sub-a', envWithPepper)

      expect(await getPasskeySessionUserId('session-a', envWithPepper)).toBeNull()
      expect(await getPasskeySessionUserId(legacySessionId, envWithPepper)).toBeNull()
      expect(await getPasskeySessionUserId(sessionBId, envWithPepper)).toBe(userB)
    } finally { envA.db.close() }
  })
})
