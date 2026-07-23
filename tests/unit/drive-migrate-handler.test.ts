import { beforeEach, describe, expect, it, vi } from 'vitest'
import { onRequestPost } from '../../functions/api/drive/migrate'
import * as drive from '../../functions/_shared/drive'
import * as s3Settings from '../../functions/_shared/s3Settings'

vi.mock('../../functions/_shared/drive', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../functions/_shared/drive')>()),
  ensureFolder: vi.fn().mockResolvedValue('folder-1'),
  findJsonFile: vi.fn().mockResolvedValue('settings-file'),
  readJsonFile: vi.fn(),
  migrateMdToTxt: vi.fn(),
}))

vi.mock('../../functions/_shared/s3Settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../functions/_shared/s3Settings')>()),
  backfillAllEntries: vi.fn().mockResolvedValue(undefined),
}))

const validSettings = { enabled: true, roleArn: 'arn:aws:iam::123456789012:role/linger-s3', bucket: 'my-bucket', region: 'us-east-1' }

function makeContext(overrides: Record<string, unknown> = {}) {
  return {
    request: new Request('http://localhost/api/drive/migrate', { method: 'POST' }),
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

describe('POST /api/drive/migrate', () => {
  // Renaming a legacy .md file bumps its Drive version — a prior S3 mirror of
  // that date is left stamped with a now-stale version, so its sync status
  // would report "pending" forever unless it's re-mirrored (see migrate.ts).
  it('re-mirrors migrated dates to S3 when backup is enabled', async () => {
    vi.mocked(drive.migrateMdToTxt).mockResolvedValue(['2026-05-01', '2026-05-03'])
    vi.mocked(drive.readJsonFile).mockResolvedValue(validSettings)
    const ctx = makeContext()

    const res = await onRequestPost(ctx as any)
    const body = await res.json() as any

    expect(body.migrated).toBe(2)
    expect(body.s3Resyncing).toBe(true)
    expect(ctx.waitUntil).toHaveBeenCalledOnce()
    expect(s3Settings.backfillAllEntries).toHaveBeenCalledWith(
      'tok', 'sid', {}, {}, validSettings, 'folder-1', 'settings-file',
      ['2026-05-01', '2026-05-03'],
      'Migration re-sync', 20,
    )
  })

  it('does not attempt a re-mirror when nothing was migrated', async () => {
    vi.mocked(drive.migrateMdToTxt).mockResolvedValue([])
    const ctx = makeContext()

    const res = await onRequestPost(ctx as any)
    const body = await res.json() as any

    expect(body.migrated).toBe(0)
    expect(body.s3Resyncing).toBe(false)
    expect(ctx.waitUntil).not.toHaveBeenCalled()
    expect(s3Settings.backfillAllEntries).not.toHaveBeenCalled()
    expect(drive.findJsonFile).not.toHaveBeenCalled()
  })

  it('does not attempt a re-mirror when S3 backup is not configured', async () => {
    vi.mocked(drive.migrateMdToTxt).mockResolvedValue(['2026-05-01'])
    vi.mocked(drive.findJsonFile).mockResolvedValue(null)
    const ctx = makeContext()

    const res = await onRequestPost(ctx as any)
    const body = await res.json() as any

    expect(body.migrated).toBe(1)
    expect(body.s3Resyncing).toBe(false)
    expect(ctx.waitUntil).not.toHaveBeenCalled()
    expect(s3Settings.backfillAllEntries).not.toHaveBeenCalled()
  })

  it('does not attempt a re-mirror when S3 backup is configured but disabled', async () => {
    vi.mocked(drive.migrateMdToTxt).mockResolvedValue(['2026-05-01'])
    vi.mocked(drive.readJsonFile).mockResolvedValue({ ...validSettings, enabled: false })
    const ctx = makeContext()

    const res = await onRequestPost(ctx as any)
    const body = await res.json() as any

    expect(body.migrated).toBe(1)
    expect(body.s3Resyncing).toBe(false)
    expect(ctx.waitUntil).not.toHaveBeenCalled()
    expect(s3Settings.backfillAllEntries).not.toHaveBeenCalled()
  })

  // The rename already committed on Drive by this point — a transient failure looking
  // up S3 settings afterwards must not turn a successful migration into an error
  // response (see migrate.ts's inner try/catch around the re-mirror lookup).
  it('still reports success when the S3 re-mirror lookup itself fails', async () => {
    vi.mocked(drive.migrateMdToTxt).mockResolvedValue(['2026-05-01'])
    vi.mocked(drive.ensureFolder).mockRejectedValue(new Error('Drive hiccup'))
    const ctx = makeContext()

    const res = await onRequestPost(ctx as any)
    const body = await res.json() as any

    expect(res.status).toBe(200)
    expect(body.migrated).toBe(1)
    expect(body.s3Resyncing).toBe(false)
    expect(ctx.waitUntil).not.toHaveBeenCalled()
  })

  it('rejects unauthenticated requests', async () => {
    const ctx = makeContext({ data: { accessToken: 'tok', sessionId: 'sid', session: null } })

    const res = await onRequestPost(ctx as any)

    expect(res.status).toBe(401)
    expect(drive.migrateMdToTxt).not.toHaveBeenCalled()
  })

  it('returns 500 when the rename itself fails, without attempting a re-mirror', async () => {
    vi.mocked(drive.migrateMdToTxt).mockRejectedValue(new Error('Drive PATCH failed'))
    const ctx = makeContext()

    const res = await onRequestPost(ctx as any)

    expect(res.status).toBe(500)
    expect(drive.ensureFolder).not.toHaveBeenCalled()
    expect(s3Settings.backfillAllEntries).not.toHaveBeenCalled()
  })
})
