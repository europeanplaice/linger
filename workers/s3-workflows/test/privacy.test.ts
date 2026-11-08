import { env, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import { getSession } from '../../../functions/_shared/session'
import { sessionStorageId } from '../../../functions/_shared/authStore'
import type { DiaryWriter } from '../src/diaryWriter'
import type { S3SyncIndex } from '../src/syncIndex'
import type { WorkflowEnv } from '../src/types'
import { authorizedSession } from '../src/runtime'
import { openVaultValue } from '../../../functions/_shared/vaultCrypto'
import { createTestSession, testSession, vaultKey } from './auth'

vi.mock('../../../functions/_shared/drive', async importOriginal => ({
  ...await importOriginal<typeof import('../../../functions/_shared/drive')>(),
  ensureFolder: vi.fn(async (_token: string, _id: string, session: { folder_id?: string }) => {
    session.folder_id = 'drive-folder-sensitive-sentinel'
    return 'drive-folder-sensitive-sentinel'
  }),
  getEntryMeta: vi.fn(async (_token: string, id: string) => ({
    id, name: 'linger_diary', mimeType: 'application/vnd.google-apps.folder',
  })),
}))

const credentials = {
  access_token: 'privacy-access-sentinel',
  refresh_token: 'privacy-refresh-sentinel',
  id_token: 'privacy-id-sentinel',
  secretAccessKey: 'privacy-aws-secret-sentinel',
}

describe('Workers metadata privacy', () => {
  it('keeps Google identifiers and folder metadata encrypted in D1 and requires the vault key', async () => {
    const userId = `privacy-user-${crypto.randomUUID()}`
    const sessionId = `privacy-session-${crypto.randomUUID()}`
    const googleSub = `google-sub-sensitive-${crypto.randomUUID()}`
    const key = vaultKey()
    const session = testSession(userId, {
      ...credentials,
      email: 'privacy@example.com',
      google_sub: googleSub,
      folder_id: 'drive-folder-sensitive-sentinel',
      vault_key: key,
    })
    await createTestSession(sessionId, session, env)

    const auth = await env.AUTH_DB.prepare('SELECT id, user_id, data FROM auth_sessions WHERE id = ?')
      .bind(await sessionStorageId(sessionId)).first<{ id: string; user_id: string; data: string | null }>()
    const profile = await env.AUTH_DB.prepare('SELECT account_envelope FROM passkey_users WHERE id = ?')
      .bind(userId).first<{ account_envelope: string }>()
    expect(auth).toMatchObject({ user_id: userId, data: null })
    expect(auth!.id).not.toBe(sessionId)
    expect(profile!.account_envelope).toMatch(/^v1\./)
    const persisted = JSON.stringify({ auth, profile })
    for (const sensitive of [googleSub, session.email, session.folder_id, ...Object.values(credentials), key]) {
      expect(persisted).not.toContain(sensitive)
    }

    expect(await getSession(sessionId, env)).toBeNull()
    expect(await getSession(sessionId, env, key)).toMatchObject({ user_id: userId, google_sub: googleSub, folder_id: session.folder_id })
  })

  it('encrypts Drive IDs in DiaryWriter storage and fails closed without a vault key', async () => {
    const userId = `privacy-do-user-${crypto.randomUUID()}`
    const sessionId = `privacy-do-session-${crypto.randomUUID()}`
    const googleSub = `google-sub-sensitive-${crypto.randomUUID()}`
    const key = vaultKey()
    const session = testSession(userId, { google_sub: googleSub, vault_key: key })
    await createTestSession(sessionId, session, env)
    const workflowEnv = env as unknown as WorkflowEnv
    const writer = workflowEnv.DIARY_WRITER.getByName(userId)
    const auth = {
      sessionId,
      accountKey: userId,
      vaultKey: key,
      accessToken: credentials.access_token,
      expiresAt: Date.now() + 3_600_000,
      idToken: credentials.id_token,
    }

    await expect(authorizedSession(workflowEnv, { sessionId, accountKey: userId })).rejects.toThrow(/unauthorized/i)
    expect(await writer.ensureFolder(auth)).toBe('drive-folder-sensitive-sentinel')

    const stored = await runInDurableObject(writer, async (_instance: DiaryWriter, state) =>
      Object.fromEntries(await state.storage.list()),
    ) as Record<string, string>
    expect(stored.folder).toMatch(/^v1\./)
    expect(await openVaultValue<string>(key, userId, 'diary-writer:folder', stored.folder)).toBe('drive-folder-sensitive-sentinel')
    const persisted = JSON.stringify(stored)
    for (const sensitive of [googleSub, 'drive-folder-sensitive-sentinel', credentials.access_token, credentials.id_token, key]) {
      expect(persisted).not.toContain(sensitive)
    }
  })

  it('does not persist Drive file IDs in the S3 sync index', async () => {
    const userId = `privacy-index-user-${crypto.randomUUID()}`
    const workflowEnv = env as unknown as WorkflowEnv
    const index = workflowEnv.S3_SYNC_INDEX.getByName(userId)
    const fileId = `drive-file-sensitive-${crypto.randomUUID()}`
    await runInDurableObject(index, (instance: S3SyncIndex, state) => {
      instance.markSynced('2026-01-01', '3', new Date().toISOString(), fileId)
      const row = state.storage.sql.exec<{ file_id: string | null }>(
        "SELECT file_id FROM entries WHERE date = '2026-01-01'",
      ).one()
      expect(row.file_id).toBeNull()
      expect(JSON.stringify(state.storage.sql.exec('SELECT * FROM entries').toArray())).not.toContain(fileId)
    })
  })
})
