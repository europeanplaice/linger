import { beforeEach, describe, expect, it, vi } from 'vitest'
import { onRequestPost } from '../../functions/api/s3/precheck'
import * as drive from '../../functions/_shared/drive'
import * as session from '../../functions/_shared/session'
import * as s3 from '../../functions/_shared/s3'

// A fixed value rather than Date.now()-derived so mock setup and toHaveBeenCalledWith
// assertions always agree, instead of drifting by whatever milliseconds elapsed
// between two separate Date.now() calls.
const { MOCK_CREDS_EXPIRES_AT } = vi.hoisted(() => ({ MOCK_CREDS_EXPIRES_AT: Date.parse('2026-06-01T00:00:00.000Z') }))

vi.mock('../../functions/_shared/drive', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../functions/_shared/drive')>()),
  listEntries: vi.fn().mockResolvedValue([]),
}))

vi.mock('../../functions/_shared/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../functions/_shared/session')>()),
  getValidIdToken: vi.fn().mockResolvedValue('id-token'),
}))

vi.mock('../../functions/_shared/s3', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../functions/_shared/s3')>()),
  assumeRoleWithWebIdentity: vi.fn().mockResolvedValue({ accessKeyId: 'ak', secretAccessKey: 'sk', sessionToken: 'st', expiresAt: MOCK_CREDS_EXPIRES_AT }),
  listObjectKeys: vi.fn().mockResolvedValue([]),
}))

const validBody = { roleArn: 'arn:aws:iam::123456789012:role/linger-s3', bucket: 'my-bucket', region: 'us-east-1' }

function makeContext(overrides: Record<string, unknown> = {}) {
  return {
    request: new Request('http://localhost/api/s3/precheck', { method: 'POST', body: JSON.stringify(validBody) }),
    data: { accessToken: 'tok', sessionId: 'sid', session: {} },
    env: {},
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(drive.listEntries).mockResolvedValue([])
  vi.mocked(session.getValidIdToken).mockResolvedValue('id-token')
  vi.mocked(s3.assumeRoleWithWebIdentity).mockResolvedValue({ accessKeyId: 'ak', secretAccessKey: 'sk', sessionToken: 'st', expiresAt: MOCK_CREDS_EXPIRES_AT })
  vi.mocked(s3.listObjectKeys).mockResolvedValue([])
})

describe('POST /api/s3/precheck', () => {
  it('rejects a malformed Role ARN', async () => {
    const ctx = makeContext({
      request: new Request('http://localhost/api/s3/precheck', { method: 'POST', body: JSON.stringify({ ...validBody, roleArn: 'not-an-arn' }) }),
    })
    const res = await onRequestPost(ctx as any)
    expect(await res.json()).toMatchObject({ ok: false })
    expect(s3.assumeRoleWithWebIdentity).not.toHaveBeenCalled()
  })

  it('reports no collisions when the bucket has no diary-named objects', async () => {
    vi.mocked(drive.listEntries).mockResolvedValue([
      { id: 'f1', name: 'diary-2026-01-01.txt', version: '1' },
    ] as any)
    vi.mocked(s3.listObjectKeys).mockResolvedValue([])

    const res = await onRequestPost(makeContext() as any)

    expect(await res.json()).toEqual({ ok: true, collisions: [] })
  })

  it('reports collisions between existing bucket objects and current Drive entries', async () => {
    vi.mocked(drive.listEntries).mockResolvedValue([
      { id: 'f1', name: 'diary-2026-01-01.txt', version: '1' },
      { id: 'f2', name: 'diary-2026-01-02.txt', version: '2' },
    ] as any)
    vi.mocked(s3.listObjectKeys).mockResolvedValue(['diary-2026-01-01.txt', 'unrelated-file.txt'])

    const res = await onRequestPost(makeContext() as any)

    expect(await res.json()).toEqual({ ok: true, collisions: ['diary-2026-01-01.txt'] })
  })

  it('ignores bucket objects that do not correspond to any current Drive entry', async () => {
    vi.mocked(drive.listEntries).mockResolvedValue([
      { id: 'f1', name: 'diary-2026-01-01.txt', version: '1' },
    ] as any)
    vi.mocked(s3.listObjectKeys).mockResolvedValue(['diary-2099-12-31.txt'])

    const res = await onRequestPost(makeContext() as any)

    expect(await res.json()).toEqual({ ok: true, collisions: [] })
  })

  it('lists the bucket with the diary- prefix', async () => {
    await onRequestPost(makeContext() as any)

    expect(s3.listObjectKeys).toHaveBeenCalledWith(
      { accessKeyId: 'ak', secretAccessKey: 'sk', sessionToken: 'st', expiresAt: MOCK_CREDS_EXPIRES_AT },
      'my-bucket', 'us-east-1', 'diary-',
    )
  })

  it('returns an error without throwing when S3 access fails', async () => {
    vi.mocked(s3.listObjectKeys).mockRejectedValue(new s3.S3Error(403, 'AccessDenied'))

    const res = await onRequestPost(makeContext() as any)

    expect(await res.json()).toMatchObject({ ok: false, error: expect.stringContaining('AccessDenied') })
  })

  it('returns an error when there is no valid Google ID token', async () => {
    vi.mocked(session.getValidIdToken).mockResolvedValue(null)

    const res = await onRequestPost(makeContext() as any)

    expect(await res.json()).toMatchObject({ ok: false, error: expect.stringContaining('sign out') })
    expect(s3.assumeRoleWithWebIdentity).not.toHaveBeenCalled()
  })
})
