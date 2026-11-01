import { createSession } from '../../../functions/_shared/session'
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
  const auth = { accountKey, sessionId: accountKey }
  const session: SessionData = {
    google_sub: accountKey,
    access_token: 'privacy-access-sentinel',
    refresh_token: 'privacy-refresh-sentinel',
    expires_at: Date.now() + 3_600_000,
    id_token: 'privacy-id-sentinel',
    id_token_verified: true,
  }
  await createSession(accountKey, session, env)
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
  it('refuses direct reconciliation without request-scoped credentials before Drive or S3 access', async () => {
    const { auth, index } = await seed()
    const result = await new Service(createExecutionContext(), env).mirrorEntryNow({ ...auth, date })
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/request-scoped Google credentials/i) })
    expect(drive.findEntryMeta).not.toHaveBeenCalled()
    expect(s3.putObjectIfNewer).not.toHaveBeenCalled()
    expect(s3.deleteObject).not.toHaveBeenCalled()
    expect(await index.getEntry(date)).toBeNull()

    const row = await env.AUTH_DB.prepare('SELECT data FROM auth_sessions WHERE id = ?').bind(auth.sessionId).first<{ data: string }>()
    expect(row!.data).not.toMatch(/privacy-(access|refresh|id)-sentinel/)
  })

  it('keeps queued deletion metadata through object eviction when no request token exists', async () => {
    const { auth, index } = await seed()
    await index.queueDeletion({ ...auth, date }, 'delete-1')
    await index.deferDeletion(date, 'delete-1', Date.now() - 1)
    await evictDurableObject(index)

    expect(await runDurableObjectAlarm(index)).toBe(true)
    expect(s3.deleteObject).not.toHaveBeenCalled()
    await runInDurableObject(index, async (_instance: S3SyncIndex, state) => {
      expect(state.storage.sql.exec<{ request_id: string; attempts: number }>(
        'SELECT request_id, attempts FROM pending_deletions',
      ).one()).toMatchObject({ request_id: 'delete-1', attempts: 1 })
      expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now())
    })
  })

  it('does not enqueue a durable delete when the metadata session has no OAuth credentials', async () => {
    const { auth, index } = await seed()
    const result = await deleteEntryForAuth(env as unknown as WorkflowEnv, { ...auth, date })
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/request-scoped Google credentials/i) })
    expect(s3.deleteObject).not.toHaveBeenCalled()
    expect(await index.getEntry(date)).toBeNull()
    await runInDurableObject(index, async (_instance: S3SyncIndex, state) => {
      expect(state.storage.sql.exec('SELECT * FROM pending_deletions').toArray()).toEqual([])
    })
  })

  it('does not let an older deletion completion clear a newer queued request', async () => {
    const { auth, index } = await seed()
    await index.queueDeletion({ ...auth, date }, 'delete-1')
    await index.queueDeletion({ ...auth, date }, 'delete-2')
    await index.completeDeletion(date, 'delete-1')
    const current = await runInDurableObject(index, (instance: S3SyncIndex, state) => ({
      entry: instance.getEntry(date),
      deletion: state.storage.sql.exec<{ request_id: string }>('SELECT request_id FROM pending_deletions').one(),
    }))
    expect(current.deletion.request_id).toBe('delete-2')
    expect(current.entry).toBeNull()
    expect(s3.deleteObject).not.toHaveBeenCalled()
  })
})

describe('metadata-only S3 settings boundary', () => {
  it('refuses a target change without a request token and leaves sync history untouched', async () => {
    const { auth, index, service } = await seed()
    await index.markSynced(date, '1', new Date().toISOString(), meta.id)
    await expect(service.saveSettings({ ...auth, config: { ...config, bucket: 'other-bucket' } }))
      .rejects.toThrow(/Google credentials are request-scoped/i)
    expect(drive.writeJsonFile).not.toHaveBeenCalled()
    expect((await index.getEntry(date))?.state).toBe('synced')
  })
})
