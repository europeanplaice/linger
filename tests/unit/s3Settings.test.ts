import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  S3_BUCKET_RE, S3_SETTINGS_NEGATIVE_CACHE_MS, S3_SETTINGS_FILE_NAME,
  isValidS3Settings, getS3Settings, mirrorEntrySave, mirrorEntryDelete, backfillAllEntries,
} from '../../functions/_shared/s3Settings'
import * as drive from '../../functions/_shared/drive'
import * as session from '../../functions/_shared/session'
import * as s3 from '../../functions/_shared/s3'

vi.mock('../../functions/_shared/drive', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../functions/_shared/drive')>()),
  ensureFolder: vi.fn().mockResolvedValue('folder-1'),
  findJsonFile: vi.fn().mockResolvedValue(null),
  readJsonFile: vi.fn(),
  writeJsonFile: vi.fn().mockResolvedValue({ id: 'settings-file', name: 's3_settings.json' }),
  listEntries: vi.fn().mockResolvedValue([]),
  getEntryContent: vi.fn(),
}))

vi.mock('../../functions/_shared/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../functions/_shared/session')>()),
  getValidIdToken: vi.fn().mockResolvedValue('id-token'),
  saveSession: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../functions/_shared/s3', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../functions/_shared/s3')>()),
  assumeRoleWithWebIdentity: vi.fn().mockResolvedValue({ accessKeyId: 'ak', secretAccessKey: 'sk', sessionToken: 'st' }),
  putObjectIfNewer: vi.fn().mockResolvedValue(undefined),
  deleteObject: vi.fn().mockResolvedValue(undefined),
}))

const baseSettings = { enabled: true, roleArn: 'arn:aws:iam::123456789012:role/linger-s3', bucket: 'my-bucket', region: 'us-east-1' }

function makeSession(overrides: Record<string, unknown> = {}) {
  return { refresh_token: 'rt', access_token: 'at', expires_at: Date.now() + 100_000, ...overrides }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(drive.ensureFolder).mockResolvedValue('folder-1')
  vi.mocked(drive.findJsonFile).mockResolvedValue(null)
  vi.mocked(drive.writeJsonFile).mockResolvedValue({ id: 'settings-file', name: 's3_settings.json' })
  vi.mocked(session.getValidIdToken).mockResolvedValue('id-token')
  vi.mocked(s3.assumeRoleWithWebIdentity).mockResolvedValue({ accessKeyId: 'ak', secretAccessKey: 'sk', sessionToken: 'st' })
  vi.mocked(s3.putObjectIfNewer).mockResolvedValue(undefined)
  vi.mocked(s3.deleteObject).mockResolvedValue(undefined)
})

describe('S3_BUCKET_RE', () => {
  it('accepts a plain lowercase bucket name', () => {
    expect(S3_BUCKET_RE.test('my-linger-diary')).toBe(true)
  })

  it('rejects dotted bucket names', () => {
    expect(S3_BUCKET_RE.test('my.linger.diary')).toBe(false)
  })
})

describe('isValidS3Settings', () => {
  it('accepts a well-formed settings object', () => {
    expect(isValidS3Settings(baseSettings)).toBe(true)
  })

  it('accepts extra sync-status fields alongside the required ones', () => {
    expect(isValidS3Settings({ ...baseSettings, lastSyncError: 'boom', lastSyncErrorAt: '2026-01-01T00:00:00.000Z' })).toBe(true)
  })
})

describe('getS3Settings negative caching', () => {
  it('caches the "no settings file" result on the session so the next call skips the Drive lookup', async () => {
    const sess = makeSession()

    const first = await getS3Settings('tok', 'sid', sess, {} as any)
    expect(first).toBeNull()
    expect(drive.findJsonFile).toHaveBeenCalledTimes(1)
    expect(sess).toHaveProperty('s3_settings_negative_cache_at')

    const second = await getS3Settings('tok', 'sid', sess, {} as any)
    expect(second).toBeNull()
    expect(drive.findJsonFile).toHaveBeenCalledTimes(1) // not called again
  })

  it('re-checks Drive once the negative cache has expired', async () => {
    const sess = makeSession({ s3_settings_negative_cache_at: Date.now() - S3_SETTINGS_NEGATIVE_CACHE_MS - 1 })

    await getS3Settings('tok', 'sid', sess, {} as any)

    expect(drive.findJsonFile).toHaveBeenCalledTimes(1)
  })

  it('does not cache negatively when a settings file is found', async () => {
    vi.mocked(drive.findJsonFile).mockResolvedValue('settings-file')
    vi.mocked(drive.readJsonFile).mockResolvedValue(baseSettings)
    const sess = makeSession()

    const result = await getS3Settings('tok', 'sid', sess, {} as any)

    expect(result).toEqual(baseSettings)
    expect(sess).not.toHaveProperty('s3_settings_negative_cache_at')
  })
})

describe('mirrorEntrySave', () => {
  it('does nothing (and never touches Drive) when negatively cached', async () => {
    const sess = makeSession({ s3_settings_negative_cache_at: Date.now() })

    await mirrorEntrySave('tok', 'sid', sess, {} as any, '2026-01-01', 'hello', '5')

    expect(drive.findJsonFile).not.toHaveBeenCalled()
    expect(s3.assumeRoleWithWebIdentity).not.toHaveBeenCalled()
  })

  it('is a no-op when no settings file exists', async () => {
    const sess = makeSession()
    await mirrorEntrySave('tok', 'sid', sess, {} as any, '2026-01-01', 'hello', '5')
    expect(s3.assumeRoleWithWebIdentity).not.toHaveBeenCalled()
  })

  it('is a no-op when settings exist but are disabled', async () => {
    vi.mocked(drive.findJsonFile).mockResolvedValue('settings-file')
    vi.mocked(drive.readJsonFile).mockResolvedValue({ ...baseSettings, enabled: false })
    const sess = makeSession()
    await mirrorEntrySave('tok', 'sid', sess, {} as any, '2026-01-01', 'hello', '5')
    expect(s3.assumeRoleWithWebIdentity).not.toHaveBeenCalled()
  })

  it('mirrors the entry to S3 passing the Drive version through for ordering', async () => {
    vi.mocked(drive.findJsonFile).mockResolvedValue('settings-file')
    vi.mocked(drive.readJsonFile).mockResolvedValue(baseSettings)
    const sess = makeSession()

    await mirrorEntrySave('tok', 'sid', sess, {} as any, '2026-01-01', 'hello', '5')

    expect(s3.putObjectIfNewer).toHaveBeenCalledWith(
      { accessKeyId: 'ak', secretAccessKey: 'sk', sessionToken: 'st' },
      'my-bucket', 'us-east-1', 'diary-2026-01-01.txt', 'hello', '5',
    )
  })

  it('clears a previously recorded sync error once a mirror succeeds', async () => {
    vi.mocked(drive.findJsonFile).mockResolvedValue('settings-file')
    vi.mocked(drive.readJsonFile).mockResolvedValue({ ...baseSettings, lastSyncError: 'old failure', lastSyncErrorAt: '2026-01-01T00:00:00.000Z' })
    const sess = makeSession()

    await mirrorEntrySave('tok', 'sid', sess, {} as any, '2026-01-02', 'hello', '6')

    expect(drive.writeJsonFile).toHaveBeenCalledWith('tok', 'folder-1', S3_SETTINGS_FILE_NAME, baseSettings, 'settings-file')
  })

  it('does not rewrite the settings file when the mirror succeeds and there was no prior error', async () => {
    vi.mocked(drive.findJsonFile).mockResolvedValue('settings-file')
    vi.mocked(drive.readJsonFile).mockResolvedValue(baseSettings)
    const sess = makeSession()

    await mirrorEntrySave('tok', 'sid', sess, {} as any, '2026-01-02', 'hello', '6')

    expect(drive.writeJsonFile).not.toHaveBeenCalled()
  })

  it('records a sync error when the mirror fails, without throwing', async () => {
    vi.mocked(drive.findJsonFile).mockResolvedValue('settings-file')
    vi.mocked(drive.readJsonFile).mockResolvedValue(baseSettings)
    vi.mocked(s3.putObjectIfNewer).mockRejectedValue(new s3.S3Error(403, 'AccessDenied'))
    const sess = makeSession()

    await expect(mirrorEntrySave('tok', 'sid', sess, {} as any, '2026-01-01', 'hello', '5')).resolves.toBeUndefined()

    expect(drive.writeJsonFile).toHaveBeenCalledWith(
      'tok', 'folder-1', S3_SETTINGS_FILE_NAME,
      expect.objectContaining({ ...baseSettings, lastSyncError: expect.stringContaining('AccessDenied') }),
      'settings-file',
    )
  })

  it('does not rewrite the settings file when the same failure repeats', async () => {
    vi.mocked(drive.findJsonFile).mockResolvedValue('settings-file')
    vi.mocked(drive.readJsonFile).mockResolvedValue({ ...baseSettings, lastSyncError: 'AccessDenied', lastSyncErrorAt: '2026-01-01T00:00:00.000Z' })
    vi.mocked(s3.putObjectIfNewer).mockRejectedValue(new s3.S3Error(403, 'AccessDenied'))
    const sess = makeSession()

    await mirrorEntrySave('tok', 'sid', sess, {} as any, '2026-01-01', 'hello', '5')

    expect(drive.writeJsonFile).not.toHaveBeenCalled()
  })

  it('records a sync error when there is no valid Google ID token', async () => {
    vi.mocked(drive.findJsonFile).mockResolvedValue('settings-file')
    vi.mocked(drive.readJsonFile).mockResolvedValue(baseSettings)
    vi.mocked(session.getValidIdToken).mockResolvedValue(null)
    const sess = makeSession()

    await mirrorEntrySave('tok', 'sid', sess, {} as any, '2026-01-01', 'hello', '5')

    expect(s3.assumeRoleWithWebIdentity).not.toHaveBeenCalled()
    expect(drive.writeJsonFile).toHaveBeenCalledWith(
      'tok', 'folder-1', S3_SETTINGS_FILE_NAME,
      expect.objectContaining({ lastSyncError: expect.stringContaining('sign out') }),
      'settings-file',
    )
  })
})

describe('mirrorEntryDelete', () => {
  it('deletes the mirrored object when settings are enabled', async () => {
    vi.mocked(drive.findJsonFile).mockResolvedValue('settings-file')
    vi.mocked(drive.readJsonFile).mockResolvedValue(baseSettings)
    const sess = makeSession()

    await mirrorEntryDelete('tok', 'sid', sess, {} as any, '2026-01-01')

    expect(s3.deleteObject).toHaveBeenCalledWith(
      { accessKeyId: 'ak', secretAccessKey: 'sk', sessionToken: 'st' },
      'my-bucket', 'us-east-1', 'diary-2026-01-01.txt',
    )
  })
})

describe('backfillAllEntries', () => {
  it('mirrors every existing entry once, reusing a single set of assumed credentials', async () => {
    vi.mocked(drive.listEntries).mockResolvedValue([
      { id: 'f1', name: 'diary-2026-01-01.txt', version: '1' },
      { id: 'f2', name: 'diary-2026-01-02.txt', version: '2' },
    ] as any)
    vi.mocked(drive.getEntryContent).mockImplementation(async (_tok, fileId) =>
      ({ date: '', content: fileId === 'f1' ? 'day one' : 'day two' }))
    const sess = makeSession()

    await backfillAllEntries('tok', 'sid', sess, {} as any, baseSettings, 'folder-1', 'settings-file')

    expect(s3.assumeRoleWithWebIdentity).toHaveBeenCalledOnce()
    expect(s3.putObjectIfNewer).toHaveBeenCalledWith(expect.anything(), 'my-bucket', 'us-east-1', 'diary-2026-01-01.txt', 'day one', '1')
    expect(s3.putObjectIfNewer).toHaveBeenCalledWith(expect.anything(), 'my-bucket', 'us-east-1', 'diary-2026-01-02.txt', 'day two', '2')
  })

  it('skips files that are not diary entries', async () => {
    vi.mocked(drive.listEntries).mockResolvedValue([
      { id: 'f1', name: 's3_settings.json', version: '1' },
    ] as any)
    const sess = makeSession()

    await backfillAllEntries('tok', 'sid', sess, {} as any, baseSettings, 'folder-1', 'settings-file')

    expect(drive.getEntryContent).not.toHaveBeenCalled()
    expect(s3.putObjectIfNewer).not.toHaveBeenCalled()
  })

  it('records a descriptive failure and does not throw when the backfill fails partway through', async () => {
    vi.mocked(drive.listEntries).mockRejectedValue(new Error('Drive is down'))
    const sess = makeSession()

    await expect(backfillAllEntries('tok', 'sid', sess, {} as any, baseSettings, 'folder-1', 'settings-file')).resolves.toBeUndefined()

    expect(drive.writeJsonFile).toHaveBeenCalledWith(
      'tok', 'folder-1', S3_SETTINGS_FILE_NAME,
      expect.objectContaining({ lastSyncError: expect.stringContaining('Drive is down') }),
      'settings-file',
    )
  })
})
