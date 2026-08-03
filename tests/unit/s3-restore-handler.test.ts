import { beforeEach, describe, expect, it, vi } from 'vitest'
import { onRequestGet, onRequestPost } from '../../functions/api/s3/restore'
import * as s3 from '../../functions/_shared/s3'
import * as drive from '../../functions/_shared/drive'
import * as s3Settings from '../../functions/_shared/s3Settings'

vi.mock('../../functions/_shared/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../functions/_shared/session')>()),
  getValidIdToken: vi.fn().mockResolvedValue('fake-id-token'),
}))

vi.mock('../../functions/_shared/s3', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../functions/_shared/s3')>()),
  listObjectKeys: vi.fn(),
  getObjectContent: vi.fn(),
}))

vi.mock('../../functions/_shared/drive', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../functions/_shared/drive')>()),
  listEntries: vi.fn(),
  findEntryMeta: vi.fn(),
  ensureFolder: vi.fn().mockResolvedValue('folder-1'),
  saveEntry: vi.fn(),
}))

vi.mock('../../functions/_shared/s3Settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../functions/_shared/s3Settings')>()),
  loadS3SettingsRecord: vi.fn(),
  getAssumedCredentials: vi.fn().mockResolvedValue({ accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'ST', expiresAt: 0 }),
  mirrorEntrySave: vi.fn().mockResolvedValue(undefined),
}))

const validRecord = {
  config: { enabled: true, roleArn: 'arn:aws:iam::123456789012:role/linger-s3', bucket: 'my-bucket', region: 'us-east-1' },
  status: {},
  folderId: 'folder-1',
}

function makeContext(overrides: Record<string, unknown> = {}) {
  return {
    request: new Request('http://localhost/api/s3/restore', { method: 'POST' }),
    data: { accessToken: 'tok', sessionId: 'sid', session: { google_sub: '123' } },
    env: {},
    waitUntil: vi.fn(),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(s3Settings.loadS3SettingsRecord).mockResolvedValue(validRecord as any)
})

describe('GET /api/s3/restore', () => {
  it('lists only dates present in the bucket but missing from Drive', async () => {
    vi.mocked(s3.listObjectKeys).mockResolvedValue([
      'diary-2024-01-01.txt',
      'diary-2024-01-02.txt',
      'diary-2024-01-03.txt',
      'other-file.txt',
    ])
    vi.mocked(drive.listEntries).mockResolvedValue([
      { id: 'f1', name: 'diary-2024-01-01.txt' },
      { id: 'f2', name: 'diary-2024-01-03.txt' },
    ] as any)

    const ctx = makeContext({ request: new Request('http://localhost/api/s3/restore', { method: 'GET' }) })
    const res = await onRequestGet(ctx as any)
    const body = await res.json() as any

    expect(body.dates).toEqual(['2024-01-02'])
  })

  it('returns 400 when backup is disabled', async () => {
    vi.mocked(s3Settings.loadS3SettingsRecord).mockResolvedValue({
      ...validRecord,
      config: { ...validRecord.config, enabled: false },
    } as any)
    const ctx = makeContext({ request: new Request('http://localhost/api/s3/restore', { method: 'GET' }) })
    const res = await onRequestGet(ctx as any)
    expect(res.status).toBe(400)
  })
})

describe('POST /api/s3/restore', () => {
  it('recreates the entry in Drive from the bucket content', async () => {
    vi.mocked(s3.getObjectContent).mockResolvedValue('recovered body')
    vi.mocked(drive.findEntryMeta).mockResolvedValue(null)
    vi.mocked(drive.saveEntry).mockResolvedValue({ id: 'new-file', name: 'diary-2024-01-02.txt', version: '9' } as any)

    const ctx = makeContext({ request: new Request('http://localhost/api/s3/restore', { method: 'POST', body: JSON.stringify({ date: '2024-01-02' }), headers: { 'Content-Type': 'application/json' } }) })
    const res = await onRequestPost(ctx as any)
    const body = await res.json() as any

    expect(body.ok).toBe(true)
    expect(drive.saveEntry).toHaveBeenCalledWith('tok', { date: '2024-01-02', content: 'recovered body' }, 'folder-1')
    expect(s3Settings.mirrorEntrySave).toHaveBeenCalledWith('tok', 'sid', expect.anything(), {}, '2024-01-02', 'recovered body', 'new-file', '9')
    expect(ctx.waitUntil).toHaveBeenCalled()
  })

  it('refuses to clobber an entry that exists in Drive', async () => {
    vi.mocked(s3.getObjectContent).mockResolvedValue('old body')
    vi.mocked(drive.findEntryMeta).mockResolvedValue({ id: 'f1', name: 'diary-2024-01-02.txt' } as any)

    const ctx = makeContext({ request: new Request('http://localhost/api/s3/restore', { method: 'POST', body: JSON.stringify({ date: '2024-01-02' }), headers: { 'Content-Type': 'application/json' } }) })
    const res = await onRequestPost(ctx as any)
    const body = await res.json() as any

    expect(res.status).toBe(409)
    expect(body.ok).toBe(false)
    expect(drive.saveEntry).not.toHaveBeenCalled()
  })

  it('returns 404 when the bucket has no object for the date', async () => {
    vi.mocked(s3.getObjectContent).mockResolvedValue(null)

    const ctx = makeContext({ request: new Request('http://localhost/api/s3/restore', { method: 'POST', body: JSON.stringify({ date: '2024-01-02' }), headers: { 'Content-Type': 'application/json' } }) })
    const res = await onRequestPost(ctx as any)
    const body = await res.json() as any

    expect(res.status).toBe(404)
    expect(body.ok).toBe(false)
    expect(drive.saveEntry).not.toHaveBeenCalled()
  })

  it('rejects an invalid date', async () => {
    const ctx = makeContext({ request: new Request('http://localhost/api/s3/restore', { method: 'POST', body: JSON.stringify({ date: 'not-a-date' }), headers: { 'Content-Type': 'application/json' } }) })
    const res = await onRequestPost(ctx as any)
    expect(res.status).toBe(400)
    expect(drive.saveEntry).not.toHaveBeenCalled()
  })
})
