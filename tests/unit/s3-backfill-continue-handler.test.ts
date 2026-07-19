import { beforeEach, describe, expect, it, vi } from 'vitest'
import { onRequestPost } from '../../functions/api/s3/backfill-continue'
import * as drive from '../../functions/_shared/drive'
import * as s3Settings from '../../functions/_shared/s3Settings'

vi.mock('../../functions/_shared/drive', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../functions/_shared/drive')>()),
  ensureFolder: vi.fn().mockResolvedValue('folder-1'),
  findJsonFile: vi.fn().mockResolvedValue('settings-file'),
  readJsonFile: vi.fn(),
  listEntries: vi.fn().mockResolvedValue([]),
  writeJsonFile: vi.fn().mockResolvedValue({ id: 'settings-file', name: 's3_settings.json' }),
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
      backfillProgress: { total: 10, done: 10, failed: [], finishedAt: '2026-01-01T00:00:00.000Z' },
    })
    const ctx = makeContext()

    const res = await onRequestPost(ctx as any)
    const body = await res.json() as any

    expect(body.ok).toBe(true)
    expect(body.done).toBe(true)
    expect(ctx.waitUntil).not.toHaveBeenCalled()
  })

  it('processes the next chunk when progress shows ongoing backfill', async () => {
    vi.mocked(drive.readJsonFile).mockResolvedValue({
      ...validSettings,
      backfillProgress: { total: 5, done: 2, failed: [] },
    })
    vi.mocked(drive.listEntries).mockResolvedValue([
      { id: 'f1', name: 'diary-2026-01-01.txt', version: '1' },
      { id: 'f2', name: 'diary-2026-01-02.txt', version: '2' },
      { id: 'f3', name: 'diary-2026-01-03.txt', version: '3' },
      { id: 'f4', name: 'diary-2026-01-04.txt', version: '4' },
      { id: 'f5', name: 'diary-2026-01-05.txt', version: '5' },
    ] as any)
    const ctx = makeContext()

    const res = await onRequestPost(ctx as any)
    const body = await res.json() as any

    expect(body.ok).toBe(true)
    expect(body.remaining).toBe(3) // entries 3, 4, 5 remain
    expect(ctx.waitUntil).toHaveBeenCalledOnce()
    expect(s3Settings.backfillAllEntries).toHaveBeenCalledWith(
      'tok', 'sid', {}, {}, expect.objectContaining(validSettings), 'folder-1', 'settings-file',
      ['2026-01-03', '2026-01-04', '2026-01-05'],
      'Backfill', 20,
    )
  })

  it('returns done:true when no remaining dates exist (all entries processed)', async () => {
    vi.mocked(drive.readJsonFile).mockResolvedValue({
      ...validSettings,
      backfillProgress: { total: 2, done: 2, failed: [] },
    })
    vi.mocked(drive.listEntries).mockResolvedValue([
      { id: 'f1', name: 'diary-2026-01-01.txt', version: '1' },
      { id: 'f2', name: 'diary-2026-01-02.txt', version: '2' },
    ] as any)
    const ctx = makeContext()

    const res = await onRequestPost(ctx as any)
    const body = await res.json() as any

    expect(body.ok).toBe(true)
    expect(body.done).toBe(true)
    expect(ctx.waitUntil).not.toHaveBeenCalled()
  })

  it('retries only failed entries when previous run finished with failures', async () => {
    vi.mocked(drive.readJsonFile).mockResolvedValue({
      ...validSettings,
      backfillProgress: { total: 3, done: 3, failed: ['2026-01-02'] },
    })
    vi.mocked(drive.listEntries).mockResolvedValue([
      { id: 'f1', name: 'diary-2026-01-01.txt', version: '1' },
      { id: 'f2', name: 'diary-2026-01-02.txt', version: '2' },
      { id: 'f3', name: 'diary-2026-01-03.txt', version: '3' },
    ] as any)
    const ctx = makeContext()

    const res = await onRequestPost(ctx as any)
    const body = await res.json() as any

    expect(body.ok).toBe(true)
    expect(body.remaining).toBe(1)
    expect(s3Settings.backfillAllEntries).toHaveBeenCalledWith(
      'tok', 'sid', {}, {}, expect.objectContaining(validSettings), 'folder-1', 'settings-file',
      ['2026-01-02'],
      'Backfill', 20,
    )
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
