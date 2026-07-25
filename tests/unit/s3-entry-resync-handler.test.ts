import { beforeEach, describe, expect, it, vi } from 'vitest'
import { onRequestPost } from '../../functions/api/s3/entry-resync/[date]'
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
    request: new Request('http://localhost/api/s3/entry-resync/2026-05-01', { method: 'POST' }),
    params: { date: '2026-05-01' },
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
  vi.mocked(drive.readJsonFile).mockResolvedValue(validSettings)
})

describe('POST /api/s3/entry-resync/[date]', () => {
  it('rejects an invalid date', async () => {
    const res = await onRequestPost(makeContext({ params: { date: 'not-a-date' } }) as any)
    expect(res.status).toBe(400)
  })

  it('rejects when S3 backup is not configured', async () => {
    vi.mocked(drive.findJsonFile).mockResolvedValue(null)

    const res = await onRequestPost(makeContext() as any)

    expect(res.status).toBe(400)
    expect(s3Settings.backfillAllEntries).not.toHaveBeenCalled()
  })

  it('rejects when S3 backup is disabled', async () => {
    vi.mocked(drive.readJsonFile).mockResolvedValue({ ...validSettings, enabled: false })

    const res = await onRequestPost(makeContext() as any)

    expect(res.status).toBe(400)
    expect(s3Settings.backfillAllEntries).not.toHaveBeenCalled()
  })

  it('awaits a single-date backfill directly rather than firing it via waitUntil', async () => {
    const ctx = makeContext()

    const res = await onRequestPost(ctx as any)
    const body = await res.json() as any

    expect(body.ok).toBe(true)
    expect(ctx.waitUntil).not.toHaveBeenCalled()
    expect(s3Settings.backfillAllEntries).toHaveBeenCalledWith(
      'tok', 'sid', {}, {}, validSettings, 'folder-1', 'settings-file', ['2026-05-01'], 'Retry',
    )
  })
})
