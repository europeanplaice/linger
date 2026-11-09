import { createTestSession, testSession } from './auth'
import { sessionStorageId } from '../../../functions/_shared/authStore'
import { createExecutionContext, env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as drive from '../../../functions/_shared/drive'
import * as s3 from '../../../functions/_shared/s3'
import type { SessionData } from '../../../functions/_shared/session'
import Service from '../src/index'
import { deleteEntryForAuth, type S3Config } from '../src/runtime'
import type { S3SyncIndex } from '../src/syncIndex'
import type { WorkflowEnv } from '../src/types'

const config: S3Config = { enabled: true, bucket: 'my-bucket', region: 'us-east-1', roleArn: 'arn:aws:iam::123456789012:role/linger' }
const date = '2026-10-01'
const meta = { id: 'current-file', name: `diary-${date}.txt`, version: '1' }

vi.mock('../../../functions/_shared/drive', async importOriginal => ({
  ...await importOriginal<typeof import('../../../functions/_shared/drive')>(),
  ensureFolder: vi.fn(async () => 'folder'),
  getEntryMeta: vi.fn(async (_token: string, id: string) => ({ id, name: 'linger_diary', mimeType: 'application/vnd.google-apps.folder' })),
  findJsonFile: vi.fn(async () => 'settings'),
  readJsonFile: vi.fn(),
  writeJsonFile: vi.fn(async () => ({ id: 'settings', name: 's3_settings.json', version: '2' })),
  findEntryMeta: vi.fn(),
  getEntryContent: vi.fn(async () => ({ date, content: 'current content' })),
  getDiaryFileMeta: vi.fn(),
  listEntryPage: vi.fn(async () => ({ files: [] })),
}))

vi.mock('../../../functions/_shared/s3', async importOriginal => ({
  ...await importOriginal<typeof import('../../../functions/_shared/s3')>(),
  assumeRoleWithWebIdentity: vi.fn(),
  putObjectIfNewer: vi.fn(),
  deleteObject: vi.fn(),
}))

async function seed() {
  const accountKey = crypto.randomUUID()
  const session: SessionData = testSession(accountKey, {
    access_token: 'privacy-access-sentinel',
    refresh_token: 'privacy-refresh-sentinel',
    id_token: 'privacy-id-sentinel',
    id_token_verified: true,
  })
  const auth = { accountKey, sessionId: accountKey, vaultKey: session.vault_key }
  await createTestSession(accountKey, session, env)
  const index = env.S3_SYNC_INDEX.getByName(accountKey)
  await index.setBackupEnabled(true)
  return { auth, index, service: new Service(createExecutionContext(), env) }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(drive.readJsonFile).mockResolvedValue({ ...config })
  vi.mocked(drive.findEntryMeta).mockResolvedValue({ ...meta })
  vi.mocked(drive.getDiaryFileMeta).mockResolvedValue({ ...meta })
})

describe('metadata-only reconciliation boundaries', () => {
  it('mirrors with request credentials and records only encrypted per-date state', async () => {
    const { auth, index, service } = await seed()
    vi.mocked(s3.assumeRoleWithWebIdentity).mockResolvedValue({ accessKeyId: 'key', secretAccessKey: 'secret', sessionToken: 'token', expiresAt: Date.now() + 600_000 })
    const input = { ...auth, date, accessToken: 'request-access', idToken: 'request-id', expiresAt: Date.now() + 600_000 }
    expect(await service.mirrorEntryNow(input)).toEqual({ ok: true })
    expect(s3.putObjectIfNewer).toHaveBeenCalledOnce()
    expect(await index.getProtectedEntry(auth, date)).toMatchObject({ state: 'synced', driveVersion: '1', syncedVersion: '1' })
    const stored = await runInDurableObject(index, (_instance: S3SyncIndex, state) => ({
      entries: state.storage.sql.exec('SELECT * FROM entries').toArray(),
      protected: state.storage.sql.exec('SELECT * FROM protected_entries').toArray(),
    }))
    expect(stored.entries).toEqual([])
    expect(JSON.stringify(stored)).not.toContain(date)
    expect(JSON.stringify(stored)).not.toContain(meta.id)
    expect(JSON.stringify(stored)).not.toContain('request-access')
  })

  it('refuses direct reconciliation without request-scoped credentials before Drive or S3 access', async () => {
    const { auth, index } = await seed()
    const result = await new Service(createExecutionContext(), env).mirrorEntryNow({ ...auth, date })
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/request-scoped Google credentials/i) })
    expect(drive.findEntryMeta).not.toHaveBeenCalled()
    expect(s3.putObjectIfNewer).not.toHaveBeenCalled()
    expect(s3.deleteObject).not.toHaveBeenCalled()
    expect(await index.getProtectedEntry(auth, date)).toBeNull()

    const row = await env.AUTH_DB.prepare('SELECT data FROM auth_sessions WHERE id = ?').bind(await sessionStorageId(auth.sessionId)).first<{ data: string | null }>()
    expect(row!.data).toBeNull()
  })

  it('drops legacy durable deletion retries after eviction because retries require a request unlock', async () => {
    const { auth, index } = await seed()
    await runInDurableObject(index, async (_instance: S3SyncIndex, state) => {
      state.storage.sql.exec('INSERT INTO pending_deletions (date, request_id, session_id, account_key, next_attempt, attempts) VALUES (?, ?, ?, ?, ?, 0)', date, 'delete-1', auth.sessionId, auth.accountKey, Date.now() - 1)
      await state.storage.setAlarm(Date.now() + 1)
    })
    await evictDurableObject(index)

    expect(await runDurableObjectAlarm(index)).toBe(false)
    expect(s3.deleteObject).not.toHaveBeenCalled()
    await runInDurableObject(index, async (_instance: S3SyncIndex, state) => {
      expect(state.storage.sql.exec('SELECT * FROM pending_deletions').toArray()).toEqual([])
      expect(await state.storage.getAlarm()).toBeNull()
    })
  })

  it('does not enqueue a durable delete when the metadata session has no OAuth credentials', async () => {
    const { auth, index } = await seed()
    const result = await deleteEntryForAuth(env as unknown as WorkflowEnv, { ...auth, date })
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/request-scoped Google credentials/i) })
    expect(s3.deleteObject).not.toHaveBeenCalled()
    expect(await index.getProtectedEntry(auth, date)).toBeNull()
    await runInDurableObject(index, async (_instance: S3SyncIndex, state) => {
      expect(state.storage.sql.exec('SELECT * FROM pending_deletions').toArray()).toEqual([])
    })
  })

  it('does not expose the retired plaintext deletion queue', async () => {
    const { index } = await seed()
    await runInDurableObject(index, (instance: S3SyncIndex) => {
      expect('queueDeletion' in instance).toBe(false)
    })
  })

})

describe('metadata-only S3 settings boundary', () => {
  it('refuses a target change without a request token and leaves sync history untouched', async () => {
    const { auth, index, service } = await seed()
    await index.updateProtectedEntry(auth, date, 'synced', '1', new Date().toISOString())
    await expect(service.saveSettings({ ...auth, config: { ...config, bucket: 'other-bucket' } }))
      .rejects.toThrow(/Google credentials are request-scoped/i)
    expect(drive.writeJsonFile).not.toHaveBeenCalled()
    expect((await index.getProtectedEntry(auth, date))?.state).toBe('synced')
  })
})
