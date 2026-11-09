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
    const index = (env as WorkflowEnv).S3_SYNC_INDEX.getByName(userId)
    const fileId = `drive-file-sensitive-${crypto.randomUUID()}`
    const auth = { sessionId: 'request-only', accountKey: userId, vaultKey: vaultKey() }
    await index.updateProtectedEntry(auth, '2026-01-01', 'synced', '3', new Date().toISOString())
    const stored = await runInDurableObject(index, (_instance: S3SyncIndex, state) => state.storage.sql.exec('SELECT * FROM protected_entries').toArray())
    expect(JSON.stringify(stored)).not.toContain(fileId)
  })

  it('migrates legacy sync rows and protects subsequent dates, versions and status', async () => {
    const userId = `privacy-index-${crypto.randomUUID()}`
    const key = vaultKey()
    const index = (env as WorkflowEnv).S3_SYNC_INDEX.getByName(userId)
    const auth = { sessionId: 'request-only', accountKey: userId, vaultKey: key }
    const date = '2001-02-03'
    const version = '398721'
    await runInDurableObject(index, (_instance: S3SyncIndex, state) => state.storage.sql.exec("INSERT INTO entries (date, drive_version, synced_version, state, updated_at) VALUES (?, ?, ?, 'synced', ?)", date, version, version, '2026-03-04T05:06:07.000Z'))
    expect(await index.getProtectedEntry(auth, date)).toMatchObject({ date, driveVersion: version, syncedVersion: version, state: 'synced' })
    const nextDate = '2003-04-05'
    await index.updateProtectedEntry(auth, nextDate, 'failed', '82573', '2026-05-06T00:00:00.000Z', 'sentinel failure')
    const stored = await runInDurableObject(index, (_instance: S3SyncIndex, state) => ({
      old: state.storage.sql.exec('SELECT * FROM entries').toArray(),
      protected: state.storage.sql.exec('SELECT * FROM protected_entries').toArray(),
    }))
    expect(stored.old).toEqual([])
    expect(stored.protected).toHaveLength(2)
    for (const secret of [date, version, nextDate, '82573', 'sentinel failure', '2026-03-04', key]) expect(JSON.stringify(stored)).not.toContain(secret)
    expect(await index.getProtectedEntry(auth, nextDate)).toMatchObject({ state: 'failed', lastError: 'sentinel failure' })
    await runInDurableObject(index, async (instance: S3SyncIndex) => {
      await expect(instance.getProtectedEntry({ ...auth, vaultKey: undefined }, date)).rejects.toThrow(/vault key/i)
    })
  })

  it('encrypts legacy failed-date lists while retaining job status', async () => {
    const userId = `privacy-jobs-${crypto.randomUUID()}`
    const key = vaultKey()
    const index = (env as WorkflowEnv).S3_SYNC_INDEX.getByName(userId)
    const auth = { sessionId: 'request-only', accountKey: userId, vaultKey: key }
    const date = '1999-12-31'
    await runInDurableObject(index, (instance: S3SyncIndex, state) => {
      instance.startJob('request', 'job', 'workflow', true, new Date().toISOString())
      state.storage.sql.exec('UPDATE jobs SET failed = 1, failed_dates = ?, error = ? WHERE job_id = ?', JSON.stringify([date]), `legacy error for ${date}`, 'job')
      instance.finishJob('job', new Date().toISOString())
    })
    expect(await index.getProtectedJob(auth, 'job')).toMatchObject({ state: 'failed', failedDates: [date], error: `legacy error for ${date}` })
    const stored = await runInDurableObject(index, (_instance: S3SyncIndex, state) => ({
      jobs: state.storage.sql.exec('SELECT * FROM jobs').toArray(),
      dates: state.storage.sql.exec('SELECT * FROM protected_job_dates').toArray(),
      errors: state.storage.sql.exec('SELECT * FROM protected_job_errors').toArray(),
    }))
    expect(stored.dates).toHaveLength(1)
    expect(stored.errors).toHaveLength(1)
    expect(JSON.stringify(stored)).not.toContain(date)
    expect(JSON.stringify(stored)).not.toContain(key)
    // If an older deployment left a later plaintext update, retain both lists.
    const laterDate = '2000-01-01'
    await runInDurableObject(index, (_instance: S3SyncIndex, state) =>
      state.storage.sql.exec('UPDATE jobs SET failed_dates = ? WHERE job_id = ?', JSON.stringify([laterDate]), 'job'),
    )
    expect(await index.getProtectedJob(auth, 'job')).toMatchObject({ failed: 2, failedDates: [date, laterDate] })
  })

  it('rejects modified protected sync state instead of accepting corrupted metadata', async () => {
    const userId = `privacy-tamper-${crypto.randomUUID()}`
    const auth = { sessionId: 'request-only', accountKey: userId, vaultKey: vaultKey() }
    const index = (env as WorkflowEnv).S3_SYNC_INDEX.getByName(userId)
    await index.updateProtectedEntry(auth, '2004-05-06', 'synced', '7')
    await runInDurableObject(index, async (instance: S3SyncIndex, state) => {
      state.storage.sql.exec("UPDATE protected_entries SET envelope = 'v1.invalid.invalid'")
      await expect(instance.getProtectedEntry(auth, '2004-05-06')).rejects.toThrow()
      expect(state.storage.sql.exec('SELECT COUNT(*) AS n FROM protected_entries').one()).toMatchObject({ n: 1 })
    })
  })

  it('migrates failed-date lists larger than a single vault envelope', async () => {
    const userId = `privacy-large-job-${crypto.randomUUID()}`
    const auth = { sessionId: 'request-only', accountKey: userId, vaultKey: vaultKey() }
    const index = (env as WorkflowEnv).S3_SYNC_INDEX.getByName(userId)
    const dates = Array.from({ length: 4001 }, (_, i) => new Date(Date.UTC(2000, 0, 1 + i)).toISOString().slice(0, 10))
    await runInDurableObject(index, (instance: S3SyncIndex, state) => {
      instance.startJob('request', 'large-job', 'workflow', true, new Date().toISOString())
      state.storage.sql.exec('UPDATE jobs SET failed_dates = ? WHERE job_id = ?', JSON.stringify(dates), 'large-job')
      instance.finishJob('large-job', new Date().toISOString())
    })
    expect((await index.getProtectedJob(auth, 'large-job'))?.failedDates).toEqual(dates)
    await runInDurableObject(index, (_instance: S3SyncIndex, state) => {
      expect(state.storage.sql.exec('SELECT * FROM protected_job_dates').toArray()).toHaveLength(2)
      expect(JSON.stringify(state.storage.sql.exec('SELECT * FROM jobs').toArray())).not.toContain(dates[0])
    })
  })
})
