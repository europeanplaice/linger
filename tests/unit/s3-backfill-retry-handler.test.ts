import { beforeEach, describe, expect, it, vi } from 'vitest'
import { onRequestPost } from '../../functions/api/s3/backfill-retry'
import * as drive from '../../functions/_shared/drive'
import * as s3Settings from '../../functions/_shared/s3Settings'

vi.mock('../../functions/_shared/drive', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../functions/_shared/drive')>()),
  ensureFolder: vi.fn().mockResolvedValue('folder-1'),
  findJsonFile: vi.fn().mockResolvedValue('settings-file'),
  readJsonFile: vi.fn(),
}))

vi.mock('../../functions/_shared/s3Settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../functions/_shared/s3Settings')>()),
  backfillAllEntries: vi.fn().mockResolvedValue(undefined),
}))

const validSettings = { enabled: true, roleArn: 'arn:aws:iam::123456789012:role/linger-s3', bucket: 'my-bucket', region: 'us-east-1' }

function makeContext(overrides: Record<string, unknown> = {}) {
  return {
    request: new Request('http://localhost/api/s3/backfill-retry', { method: 'POST' }),
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

describe('POST /api/s3/backfill-retry', () => {
  it('rejects when S3 backup is not configured', async () => {
    vi.mocked(drive.findJsonFile).mockResolvedValue(null)
    const res = await onRequestPost(makeContext() as any)
    expect(res.status).toBe(400)
    expect(s3Settings.backfillAllEntries).not.toHaveBeenCalled()
  })

  it('rejects when there are no failed entries to retry', async () => {
    vi.mocked(drive.readJsonFile).mockResolvedValue({ ...validSettings, backfillProgress: { total: 5, done: 5, failed: [], finishedAt: '2026-01-01T00:00:00.000Z' } })
    const res = await onRequestPost(makeContext() as any)
    expect(res.status).toBe(400)
    expect(s3Settings.backfillAllEntries).not.toHaveBeenCalled()
  })

  it('retries the failed entries from a finished run', async () => {
    vi.mocked(drive.readJsonFile).mockResolvedValue({
      ...validSettings,
      backfillProgress: { total: 5, done: 5, failed: ['2026-01-01', '2026-01-02'], finishedAt: '2026-01-01T00:00:00.000Z' },
    })
    const ctx = makeContext()

    const res = await onRequestPost(ctx as any)
    const body = await res.json() as any

    expect(body.ok).toBe(true)
    expect(body.retrying).toBe(2)
    expect(ctx.waitUntil).toHaveBeenCalled()
    expect(s3Settings.backfillAllEntries).toHaveBeenCalledWith(
      'tok', 'sid', expect.anything(), {},
      expect.objectContaining({ config: expect.objectContaining({ enabled: true }), folderId: 'folder-1', configFileId: 'settings-file' }),
      ['2026-01-01', '2026-01-02'], 'Retry', 20,
    )
  })

  it('rejects with a conflict instead of starting a second concurrent run when a backfill/resync is already active', async () => {
    // Regression guard: backfillAllEntries's finish/chunk bookkeeping (total/done/
    // remaining/finishedAt) assumes only one chunked run drives it at a time. If a
    // whole-account Resync (or the initial backfill) is still mid-flight when this
    // fires — e.g. from another tab — and this run's own (small) failed-list scope
    // fits within one chunk, it would reach backfillAllEntries's terminal
    // finishBackfill and falsely stamp the *other*, still-running run as finished,
    // truncating it (same class of bug fixed for entry-resync's single-date retry).
    vi.mocked(drive.readJsonFile).mockResolvedValue({
      ...validSettings,
      backfillProgress: {
        total: 500, done: 120, failed: ['2026-01-01'], remaining: Array.from({ length: 380 }, (_, i) => `date-${i}`),
        updatedAt: new Date().toISOString(),
      },
    })

    const res = await onRequestPost(makeContext() as any)

    expect(res.status).toBe(409)
    expect(s3Settings.backfillAllEntries).not.toHaveBeenCalled()
  })

  it('retries anyway when the existing run is stale (orphaned, no recent progress write)', async () => {
    // isBackfillRunActive treats a run with no update in the last ~10 minutes as
    // abandoned rather than active — otherwise an isolate that died mid-backfill (or
    // a client that never came back to keep polling backfill-continue.ts) would
    // permanently 409 every future retry, with no way to recover short of a manual
    // Drive edit.
    vi.mocked(drive.readJsonFile).mockResolvedValue({
      ...validSettings,
      backfillProgress: {
        total: 500, done: 120, failed: ['2026-01-01'], remaining: Array.from({ length: 380 }, (_, i) => `date-${i}`),
        updatedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
      },
    })
    const ctx = makeContext()

    const res = await onRequestPost(ctx as any)

    expect(res.status).toBe(200)
    expect(s3Settings.backfillAllEntries).toHaveBeenCalledOnce()
  })
})
