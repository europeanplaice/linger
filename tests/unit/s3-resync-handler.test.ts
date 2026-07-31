import { beforeEach, describe, expect, it, vi } from 'vitest'
import { onRequestPost } from '../../functions/api/s3/resync'
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
    request: new Request('http://localhost/api/s3/resync', { method: 'POST' }),
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

describe('POST /api/s3/resync', () => {
  it('rejects when S3 backup is not configured', async () => {
    vi.mocked(drive.findJsonFile).mockResolvedValue(null)
    const res = await onRequestPost(makeContext() as any)
    expect(res.status).toBe(400)
    expect(s3Settings.backfillAllEntries).not.toHaveBeenCalled()
  })

  it('rejects when S3 backup is configured but disabled', async () => {
    vi.mocked(drive.readJsonFile).mockResolvedValue({ ...validSettings, enabled: false })
    const res = await onRequestPost(makeContext() as any)
    expect(res.status).toBe(400)
    expect(s3Settings.backfillAllEntries).not.toHaveBeenCalled()
  })

  it('starts a full resync when nothing else is running', async () => {
    vi.mocked(drive.readJsonFile).mockResolvedValue(validSettings)
    const ctx = makeContext()

    const res = await onRequestPost(ctx as any)
    const body = await res.json() as any

    expect(body.ok).toBe(true)
    expect(ctx.waitUntil).toHaveBeenCalledOnce()
    expect(s3Settings.backfillAllEntries).toHaveBeenCalledWith(
      'tok', 'sid', expect.anything(), {},
      expect.objectContaining({ config: expect.objectContaining({ enabled: true }) }),
      undefined, 'Resync', 20,
    )
  })

  it('rejects with a conflict instead of starting a second concurrent run when a backfill is already active', async () => {
    // Regression guard: mirrors backfill-retry.ts's identical check. A second freshStart
    // run (this one) sharing the same total/done/remaining/finishedAt bookkeeping as an
    // already-running backfill (the initial backfill, or another tab's Resync click)
    // would race it — whichever reaches its own scope's end first calls finishBackfill
    // and truncates the other.
    vi.mocked(drive.readJsonFile).mockResolvedValue({
      ...validSettings,
      backfillProgress: { total: 500, done: 120, failed: [], remaining: Array.from({ length: 380 }, (_, i) => `date-${i}`) },
    })

    const res = await onRequestPost(makeContext() as any)

    expect(res.status).toBe(409)
    expect(s3Settings.backfillAllEntries).not.toHaveBeenCalled()
  })

  it('starts a new resync once the previous run has finished', async () => {
    vi.mocked(drive.readJsonFile).mockResolvedValue({
      ...validSettings,
      backfillProgress: { total: 500, done: 500, failed: [], finishedAt: '2026-01-01T00:00:00.000Z' },
    })
    const ctx = makeContext()

    const res = await onRequestPost(ctx as any)

    expect(res.status).toBe(200)
    expect(s3Settings.backfillAllEntries).toHaveBeenCalledOnce()
  })
})
