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

vi.mock('../../../functions/_shared/drive', () => ({
  ensureFolder: vi.fn(async () => 'folder'),
  findJsonFile: vi.fn(async () => 'settings'),
  readJsonFile: vi.fn(),
  writeJsonFile: vi.fn(async () => ({ id: 'settings', name: 's3_settings.json', version: '2' })),
  findEntryMeta: vi.fn(),
  getEntryContent: vi.fn(async () => ({ date: '2026-10-01', content: 'current content' })),
  getDiaryFileMeta: vi.fn(),
  listEntryPage: vi.fn(async () => ({ files: [] })),
}))

vi.mock('../../../functions/_shared/s3', async importOriginal => ({
  ...await importOriginal<typeof import('../../../functions/_shared/s3')>(),
  assumeRoleWithWebIdentity: vi.fn(async () => ({ accessKeyId: 'test', secretAccessKey: 'test', sessionToken: 'test', expiresAt: Date.now() + 3_600_000 })),
  putObjectIfNewer: vi.fn(async () => {}),
  deleteObject: vi.fn(async () => {}),
}))

async function seed() {
  const accountKey = crypto.randomUUID()
  const auth = { accountKey, sessionId: accountKey }
  const session: SessionData = { google_sub: accountKey, access_token: 'access', refresh_token: 'refresh', expires_at: Date.now() + 3_600_000, id_token: 'identity', id_token_verified: true }
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

describe('S3 reconciliation', () => {
  it('mirrors the current file when an old delete runs after recreation', async () => {
    const { auth, index } = await seed()
    await index.markSynced(date, '100', new Date().toISOString(), 'deleted-file')
    await index.reconcileEntry({ ...auth, date, fileId: 'deleted-file', driveVersion: '100' })
    expect(s3.deleteObject).not.toHaveBeenCalled()
    expect(s3.putObjectIfNewer).toHaveBeenCalledWith(expect.anything(), config.bucket, config.region, `diary-${date}.txt`, 'current content', '1', undefined, { fileId: meta.id })
    expect(await index.getEntry(date)).toMatchObject({ state: 'synced', fileId: meta.id, syncedVersion: '1' })
  })

  it('repairs a recreation that arrives during S3 DELETE', async () => {
    const { auth, index } = await seed()
    vi.mocked(drive.findEntryMeta).mockResolvedValueOnce(null)
    await index.reconcileEntry({ ...auth, date })
    expect(s3.deleteObject).toHaveBeenCalledTimes(1)
    expect(s3.putObjectIfNewer).toHaveBeenCalledTimes(1)
    expect(await index.getEntry(date)).toMatchObject({ syncedVersion: '1', fileId: meta.id })
  })

  it('serializes concurrent S3 operations and continues after an earlier failure', async () => {
    const { auth, index } = await seed()
    await runInDurableObject(index, async (instance: S3SyncIndex) => {
      let release!: () => void
      const blocked = new Promise<void>(resolve => { release = resolve })
      let entered!: () => void
      const started = new Promise<void>(resolve => { entered = resolve })
      vi.mocked(s3.putObjectIfNewer).mockImplementationOnce(async () => { entered(); await blocked; throw new Error('network failure') })
      const first = instance.reconcileEntry({ ...auth, date }).catch(error => error)
      await started
      const second = instance.reconcileEntry({ ...auth, date })
      expect(s3.putObjectIfNewer).toHaveBeenCalledTimes(1)
      release()
      expect(await first).toBeInstanceOf(Error)
      await second
      expect(s3.putObjectIfNewer).toHaveBeenCalledTimes(2)
      expect(instance.getEntry(date)?.state).toBe('synced')
    })
  })

  it('recovers queued deletion after object eviction without an incoming status poll', async () => {
    const { auth, index } = await seed()
    vi.mocked(drive.findEntryMeta).mockResolvedValue(null)
    await index.queueDeletion({ ...auth, date }, 'delete-1')
    await index.deferDeletion(date, 'delete-1', Date.now() - 1)
    await evictDurableObject(index)
    expect(await runDurableObjectAlarm(index)).toBe(true)
    expect(s3.deleteObject).toHaveBeenCalledTimes(1)
    await runInDurableObject(index, async (_instance: S3SyncIndex, state) => {
      expect(state.storage.sql.exec('SELECT * FROM pending_deletions').toArray()).toEqual([])
      expect(await state.storage.getAlarm()).toBeNull()
    })
  })

  it('automatically retries a deletion whose Workflow could not be created', async () => {
    const { auth, index } = await seed()
    vi.mocked(drive.findEntryMeta).mockResolvedValue(null)
    const unavailable = {
      ...env,
      S3_MIRROR_WORKFLOW: {
        create: vi.fn().mockRejectedValue(new Error('Workflow unavailable')),
        get: vi.fn().mockRejectedValue(new Error('not found')),
      },
    } as unknown as WorkflowEnv
    await deleteEntryForAuth(unavailable, { ...auth, date })
    const requestId = await runInDurableObject(index, (instance: S3SyncIndex, state) => {
      expect(instance.getEntry(date)?.state).toBe('pending')
      return state.storage.sql.exec<{ request_id: string }>('SELECT request_id FROM pending_deletions').one().request_id
    })
    await index.deferDeletion(date, requestId, Date.now() - 1)
    await runDurableObjectAlarm(index)
    expect(s3.deleteObject).toHaveBeenCalledTimes(1)
    expect(await index.getEntry(date)).toBeNull()
  })

  it('retains failed deletion work and never clears a newer request with an old completion', async () => {
    const { auth, index } = await seed()
    vi.mocked(drive.findEntryMeta).mockResolvedValue(null)
    vi.mocked(s3.deleteObject).mockRejectedValueOnce(new Error('S3 unavailable'))
    await index.queueDeletion({ ...auth, date }, 'delete-1')
    await index.deferDeletion(date, 'delete-1', Date.now() - 1)
    await runDurableObjectAlarm(index)
    await runInDurableObject(index, async (_instance: S3SyncIndex, state) => {
      expect(state.storage.sql.exec('SELECT attempts FROM pending_deletions').one()).toMatchObject({ attempts: 1 })
      expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now())
    })
    await index.queueDeletion({ ...auth, date }, 'delete-2')
    await index.completeDeletion(date, 'delete-1')
    await index.deferDeletion(date, 'delete-2', Date.now() - 1)
    await runDurableObjectAlarm(index)
    expect(s3.deleteObject).toHaveBeenCalledTimes(2)
  })
})

describe('S3 target changes', () => {
  it('rejects an active-job bucket change before writing settings or clearing history', async () => {
    const { auth, index, service } = await seed()
    await index.markSynced(date, '1', new Date().toISOString(), meta.id)
    await index.startJob('active-request', 'active-job', 'active-workflow', true, new Date().toISOString())
    await expect(service.saveSettings({ ...auth, config: { ...config, bucket: 'other-bucket' } })).rejects.toThrow('already running')
    expect(drive.writeJsonFile).not.toHaveBeenCalled()
    expect((await index.getEntry(date))?.state).toBe('synced')
  })

  it('remembers a required backfill when settings are saved but startup was not completed', async () => {
    const { auth, index, service } = await seed()
    const updated = { ...config, bucket: 'other-bucket' }
    expect((await service.saveSettings({ ...auth, config: updated })).needsBackfill).toBe(true)
    vi.mocked(drive.readJsonFile).mockResolvedValue(updated)
    await evictDurableObject(index)
    expect((await service.saveSettings({ ...auth, config: updated })).needsBackfill).toBe(true)
    await index.markBackfillStarted(updated.bucket)
    expect((await service.saveSettings({ ...auth, config: updated })).needsBackfill).toBe(false)
  })

  it('prevents a backfill from starting while a target write is in flight', async () => {
    const { auth, index } = await seed()
    await runInDurableObject(index, async (instance: S3SyncIndex) => {
      let release!: () => void
      const blocked = new Promise<void>(resolve => { release = resolve })
      let entered!: () => void
      const started = new Promise<void>(resolve => { entered = resolve })
      vi.mocked(drive.writeJsonFile).mockImplementationOnce(async () => {
        entered()
        await blocked
        return { id: 'settings', name: 's3_settings.json', version: '2' }
      })
      const save = instance.saveBackupSettings({ ...auth, config: { ...config, bucket: 'other-bucket' } })
      await started
      expect(() => instance.startJob('concurrent-request', 'concurrent-job', 'concurrent-workflow', true, new Date().toISOString(), config.bucket)).toThrow('already running')
      release()
      expect((await save).needsBackfill).toBe(true)
    })
  })

  it('recovers a bucket change after Drive committed but its response was lost', async () => {
    const { auth, index, service } = await seed()
    await index.markSynced(date, '1', new Date().toISOString(), meta.id)
    const updated = { ...config, bucket: 'other-bucket' }
    vi.mocked(drive.writeJsonFile).mockRejectedValueOnce(new Error('lost response'))
    await expect(service.saveSettings({ ...auth, config: updated })).rejects.toThrow('lost response')
    vi.mocked(drive.readJsonFile).mockResolvedValue(updated)
    await evictDurableObject(index)
    expect((await service.saveSettings({ ...auth, config: updated })).needsBackfill).toBe(true)
    expect(await index.getEntry(date)).toBeNull()
    await expect((async () => await index.startJob('stale-request', 'stale-job', 'stale-workflow', true, new Date().toISOString(), config.bucket))()).rejects.toThrow('target changed')
  })
})
