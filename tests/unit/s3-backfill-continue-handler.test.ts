import { beforeEach, describe, expect, it, vi } from 'vitest'
import { onRequestPost } from '../../functions/api/s3/backfill-continue'
import * as drive from '../../functions/_shared/drive'
import * as s3Settings from '../../functions/_shared/s3Settings'

vi.mock('../../functions/_shared/drive', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../functions/_shared/drive')>()),
  ensureFolder: vi.fn().mockResolvedValue('folder-1'),
  findJsonFile: vi.fn().mockResolvedValue('settings-file'),
  readJsonFile: vi.fn(),
  writeJsonFile: vi.fn().mockResolvedValue({ id: 'settings-file', name: 's3_settings.json' }),
  listEntries: vi.fn(),
}))

vi.mock('../../functions/_shared/s3Settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../functions/_shared/s3Settings')>()),
  backfillAllEntries: vi.fn().mockResolvedValue(undefined),
  finishBackfill: vi.fn().mockResolvedValue(undefined),
}))

const validSettings = { enabled: true, roleArn: 'arn:aws:iam::123456789012:role/linger-s3', bucket: 'my-bucket', region: 'us-east-1' }

function makeContext(overrides: Record<string, unknown> = {}) {
  return {
    request: new Request('http://localhost/api/s3/backfill-continue', { method: 'POST' }),
    data: { accessToken: 'tok', sessionId: 'sid', session: {} },
    env: {},
    waitUntil: vi.fn(),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(drive.ensureFolder).mockResolvedValue('folder-1')
  vi.mocked(drive.findJsonFile).mockResolvedValue('settings-file')
})

describe('POST /api/s3/backfill-continue', () => {
  it('returns done:false when no progress record exists (first chunk still in-flight)', async () => {
    vi.mocked(drive.readJsonFile).mockResolvedValue(validSettings)
    const ctx = makeContext()

    const res = await onRequestPost(ctx as any)
    const body = await res.json() as any

    expect(body.ok).toBe(true)
    expect(body.done).toBe(false)
    // Should NOT start a new backfill — the trigger endpoint owns the first chunk.
    expect(ctx.waitUntil).not.toHaveBeenCalled()
    expect(s3Settings.backfillAllEntries).not.toHaveBeenCalled()
  })

  it('returns done:true when backfillProgress has finishedAt', async () => {
    vi.mocked(drive.readJsonFile).mockResolvedValue({
      ...validSettings,
      backfillProgress: { total: 10, done: 10, failed: [], remaining: [], finishedAt: '2026-01-01T00:00:00.000Z' },
    })
    const ctx = makeContext()

    const res = await onRequestPost(ctx as any)
    const body = await res.json() as any

    expect(body.ok).toBe(true)
    expect(body.done).toBe(true)
    expect(ctx.waitUntil).not.toHaveBeenCalled()
  })

  it('continues with exactly progress.remaining as the next scope, not a re-derived positional slice', async () => {
    vi.mocked(drive.readJsonFile).mockResolvedValue({
      ...validSettings,
      backfillProgress: { total: 5, done: 2, failed: [], remaining: ['2026-01-03', '2026-01-04', '2026-01-05'] },
    })
    const ctx = makeContext()

    const res = await onRequestPost(ctx as any)
    const body = await res.json() as any

    expect(body.ok).toBe(true)
    expect(body.remaining).toBe(3)
    expect(ctx.waitUntil).toHaveBeenCalledOnce()
    expect(s3Settings.backfillAllEntries).toHaveBeenCalledWith(
      'tok', 'sid', expect.anything(), {},
      expect.objectContaining({ config: validSettings, folderId: 'folder-1', configFileId: 'settings-file' }),
      ['2026-01-03', '2026-01-04', '2026-01-05'],
      'Backfill', 20,
    )
    // Crucially: no Drive listing is consulted here at all — backfillAllEntries owns that.
    expect(drive.listEntries).not.toHaveBeenCalled()
  })

  it('preserves a scoped run (e.g. a migration re-sync of >20 dates) across chunked continuation', async () => {
    // Only the 5 dates still owed by this migration re-sync should ever be passed on,
    // regardless of how many entries exist in the account overall.
    const migrationRemaining = ['2020-01-01', '2020-01-02', '2020-01-03', '2020-01-04', '2020-01-05']
    vi.mocked(drive.readJsonFile).mockResolvedValue({
      ...validSettings,
      backfillProgress: { total: 25, done: 20, failed: [], remaining: migrationRemaining },
    })
    const ctx = makeContext()

    const res = await onRequestPost(ctx as any)
    const body = await res.json() as any

    expect(body.remaining).toBe(5)
    expect(s3Settings.backfillAllEntries).toHaveBeenCalledWith(
      'tok', 'sid', expect.anything(), {},
      expect.objectContaining({ config: validSettings, folderId: 'folder-1', configFileId: 'settings-file' }),
      migrationRemaining,
      'Backfill', 20,
    )
  })

  it('finalizes when remaining is an empty array (everything already attempted)', async () => {
    vi.mocked(drive.readJsonFile).mockResolvedValue({
      ...validSettings,
      backfillProgress: { total: 2, done: 2, failed: [], remaining: [] },
    })
    const ctx = makeContext()

    const res = await onRequestPost(ctx as any)
    const body = await res.json() as any

    expect(body.ok).toBe(true)
    expect(body.done).toBe(true)
    expect(ctx.waitUntil).not.toHaveBeenCalled()
    expect(s3Settings.finishBackfill).toHaveBeenCalledWith('tok', expect.objectContaining({ folderId: 'folder-1', configFileId: 'settings-file' }), 2, [], 'Backfill')
  })

  it('finalizes a legacy in-flight record with no `remaining` field rather than resuming positionally', async () => {
    vi.mocked(drive.readJsonFile).mockResolvedValue({
      ...validSettings,
      backfillProgress: { total: 3, done: 2, failed: ['2026-01-02'] },
    })
    const ctx = makeContext()

    const res = await onRequestPost(ctx as any)
    const body = await res.json() as any

    expect(body.ok).toBe(true)
    expect(body.done).toBe(true)
    expect(ctx.waitUntil).not.toHaveBeenCalled()
    expect(s3Settings.backfillAllEntries).not.toHaveBeenCalled()
    expect(s3Settings.finishBackfill).toHaveBeenCalledWith('tok', expect.anything(), 3, ['2026-01-02'], 'Backfill')
  })

  it('rejects when S3 backup is not configured', async () => {
    vi.mocked(drive.findJsonFile).mockResolvedValue(null)
    const ctx = makeContext()

    const res = await onRequestPost(ctx as any)

    expect(res.status).toBe(400)
  })

  it('rejects when S3 backup is disabled', async () => {
    vi.mocked(drive.readJsonFile).mockResolvedValue({ ...validSettings, enabled: false })
    const ctx = makeContext()

    const res = await onRequestPost(ctx as any)

    expect(res.status).toBe(400)
  })
})
