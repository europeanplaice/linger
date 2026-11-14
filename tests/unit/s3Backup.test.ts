import { beforeEach, describe, expect, it, vi } from 'vitest'
import { executeS3Backup } from '../../functions/_shared/s3Backup'
import type { S3BackupOperation } from '../../functions/_shared/s3Workflow'
import type { S3SyncStatus } from '../../functions/_shared/s3Settings'
import * as drive from '../../functions/_shared/drive'
import * as s3 from '../../functions/_shared/s3'

vi.mock('../../functions/_shared/drive', async original => ({
  ...await original<typeof import('../../functions/_shared/drive')>(),
  ensureFolder: vi.fn(async () => 'folder'), findJsonFile: vi.fn(), readJsonFile: vi.fn(),
  writeJsonFile: vi.fn(), listEntries: vi.fn(), findCurrentEntryMeta: vi.fn(), getEntryContent: vi.fn(),
  getEntryMeta: vi.fn(async () => ({ id: 'settings', name: 'settings', trashed: false })),
}))
vi.mock('../../functions/_shared/session', async original => ({
  ...await original<typeof import('../../functions/_shared/session')>(),
  saveSession: vi.fn(), getValidIdToken: vi.fn(async () => 'id-token'),
}))
vi.mock('../../functions/_shared/s3', async original => ({
  ...await original<typeof import('../../functions/_shared/s3')>(),
  assumeRoleWithWebIdentity: vi.fn(async () => ({ accessKeyId: 'a', secretAccessKey: 's', sessionToken: 't', expiresAt: Date.now() + 100_000 })),
  putObjectIfNewer: vi.fn(), deleteObject: vi.fn(),
}))

const config = { enabled: true, roleArn: 'arn:aws:iam::123456789012:role/linger', bucket: 'my-bucket', region: 'us-east-1' }
let files: Map<string, unknown>
const dates = ['2026-01-01', '2026-01-02', '2026-01-03']
beforeEach(() => {
  vi.clearAllMocks()
  files = new Map([['s3_settings.json', config]])
  vi.mocked(drive.findJsonFile).mockImplementation(async (_t, _f, name) => files.has(name) ? name : null)
  vi.mocked(drive.readJsonFile).mockImplementation(async (_t, id) => structuredClone(files.get(id)))
  vi.mocked(drive.writeJsonFile).mockImplementation(async (_t, _f, name, value) => {
    files.set(name, structuredClone(value))
    return { id: name, name }
  })
  vi.mocked(drive.listEntries).mockResolvedValue(dates.map(date => ({ id: date, name: `diary-${date}.txt`, version: '1' })))
  vi.mocked(drive.findCurrentEntryMeta).mockImplementation(async (_t, _sid, _s, _e, date) => ({ id: date, name: `diary-${date}.txt`, version: '1' }))
  vi.mocked(drive.getEntryContent).mockResolvedValue({ date: '', content: 'text' })
  vi.mocked(s3.putObjectIfNewer).mockResolvedValue(undefined)
})
const run = (operation: S3BackupOperation) => executeS3Backup('token', 'session', { user_id: 'account' }, {} as never, operation)
const status = () => files.get('s3_sync_status.json') as S3SyncStatus

describe('coordinated backup operations', () => {
  it('checkpoints a new run before returning, leaving all entries for browser continuation', async () => {
    expect((await run({ kind: 'start' })).status).toBe(200)
    expect(status().backfillProgress).toMatchObject({ total: 3, done: 0, remaining: dates })
    expect(s3.putObjectIfNewer).not.toHaveBeenCalled()
    expect((await run({ kind: 'start' })).status).toBe(409)
  })
  it('finishes a continued run and clears its progress', async () => {
    await run({ kind: 'start' })
    expect((await run({ kind: 'continue' })).status).toBe(200)
    expect(s3.putObjectIfNewer).toHaveBeenCalledTimes(3)
    expect(status().backfillProgress).toBeUndefined()
    expect(await (await run({ kind: 'continue' })).json()).toEqual({ ok: true, done: true })
  })
  it('preserves the exact scope of a migration across continuations', async () => {
    await run({ kind: 'start', dates: [dates[2]] })
    await run({ kind: 'continue' })
    expect(s3.putObjectIfNewer).toHaveBeenCalledOnce()
    expect(s3.putObjectIfNewer).toHaveBeenCalledWith(expect.anything(), config.bucket, config.region, `diary-${dates[2]}.txt`, 'text', '1', undefined, { fileId: dates[2] })
  })
  it('retries only failed dates with a fresh total and counter', async () => {
    files.set('s3_sync_status.json', { backfillProgress: { total: 100, done: 100, failed: [dates[1]], finishedAt: new Date().toISOString() } })
    expect(await (await run({ kind: 'retry' })).json()).toEqual({ ok: true, retrying: 1 })
    expect(status().backfillProgress).toMatchObject({ total: 1, done: 0, remaining: [dates[1]] })
  })
  it('requires failed dates for a retry and enabled configuration for a start', async () => {
    expect((await run({ kind: 'retry' })).status).toBe(400)
    files.set('s3_settings.json', { ...config, enabled: false })
    expect((await run({ kind: 'start' })).status).toBe(400)
    files.delete('s3_settings.json')
    expect((await run({ kind: 'start' })).status).toBe(400)
  })
  it('preserves unfinished progress and errors on an unchanged settings save', async () => {
    await run({ kind: 'start' })
    const before = { ...status(), lastSyncError: 'AccessDenied', lastSyncErrorDate: dates[0] }
    files.set('s3_sync_status.json', before)
    expect((await run({ kind: 'settings', config })).status).toBe(200)
    expect(status()).toEqual(before)
  })
  it('blocks target changes and disabling while a run is active', async () => {
    await run({ kind: 'start' })
    for (const changed of [{ ...config, bucket: 'other-bucket' }, { ...config, enabled: false }]) {
      expect((await run({ kind: 'settings', config: changed })).status).toBe(409)
    }
    expect(files.get('s3_settings.json')).toEqual(config)
  })
  it('prepares an initial run before enabling backup', async () => {
    files.delete('s3_settings.json')
    expect((await run({ kind: 'settings', config })).status).toBe(200)
    expect(status().backfillProgress?.remaining).toEqual(dates)
    expect(vi.mocked(drive.writeJsonFile).mock.calls.map(call => call[2])).toEqual(['s3_sync_status.json', 's3_settings.json'])
  })
  it('does not enable backup when reserving progress fails', async () => {
    files.delete('s3_settings.json')
    vi.mocked(drive.writeJsonFile).mockRejectedValueOnce(new Error('checkpoint failed'))
    await expect(run({ kind: 'settings', config })).rejects.toThrow('checkpoint failed')
    expect(files.has('s3_settings.json')).toBe(false)
  })
  it('rebuilds legacy progress with no resumable scope instead of claiming completion', async () => {
    files.set('s3_sync_status.json', { backfillProgress: { total: 3, done: 1, failed: [] } })
    await run({ kind: 'continue' })
    expect(status().backfillProgress).toMatchObject({ done: 0, remaining: dates })
  })
  it('takes a fresh view despite session negative caches from a different device', async () => {
    const session = { user_id: 'account', s3_settings_negative_cache_at: Date.now(), s3_status_negative_cache_at: Date.now() }
    const response = await executeS3Backup('token', 'session', session, {} as never, { kind: 'start' })
    expect(response.status).toBe(200)
  })
})
