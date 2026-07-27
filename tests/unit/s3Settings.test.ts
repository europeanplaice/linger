import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  S3_BUCKET_RE, S3_SETTINGS_NEGATIVE_CACHE_MS, S3_SETTINGS_FILE_NAME,
  isValidS3Settings, getS3Settings, mirrorEntrySave, mirrorEntryDelete, backfillAllEntries,
  writeBackfillProgress, finishBackfill, credentialsCacheKey, resyncSingleEntry,
} from '../../functions/_shared/s3Settings'
import type { S3SettingsRecord } from '../../functions/_shared/s3Settings'
import * as drive from '../../functions/_shared/drive'
import { DriveError } from '../../functions/_shared/drive'
import * as session from '../../functions/_shared/session'
import * as s3 from '../../functions/_shared/s3'
import type { SessionData } from '../../functions/_shared/session'

vi.mock('../../functions/_shared/drive', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../functions/_shared/drive')>()),
  ensureFolder: vi.fn().mockResolvedValue('folder-1'),
  findJsonFile: vi.fn().mockResolvedValue(null),
  readJsonFile: vi.fn(),
  writeJsonFile: vi.fn().mockResolvedValue({ id: 'settings-file', name: 's3_settings.json' }),
  listEntries: vi.fn().mockResolvedValue([]),
  getEntryContent: vi.fn(),
  getDiaryFileMeta: vi.fn(),
  getEntryMeta: vi.fn(),
  findEntryMeta: vi.fn(),
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

function makeSession(overrides: Partial<SessionData> = {}): SessionData {
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
  // Default: the entry still exists in Drive post-save (the common case) — no compensating delete.
  vi.mocked(drive.getDiaryFileMeta).mockResolvedValue({ id: 'file-1', name: 'diary-2026-01-01.txt' } as any)
  // Default: a cached settings fileId still points to a live (non-trashed) file.
  vi.mocked(drive.getEntryMeta).mockResolvedValue({ id: 'settings-file', name: S3_SETTINGS_FILE_NAME, trashed: false } as any)
  vi.mocked(drive.findEntryMeta).mockResolvedValue({ id: 'file-1', name: 'diary-2026-01-01.txt', version: '5' } as any)
  vi.mocked(drive.getEntryContent).mockResolvedValue({ date: '2026-01-01', content: 'hello' })
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

describe('getS3Settings fileId caching', () => {
  it('caches the settings fileId on the session so a second call skips the files.list lookup', async () => {
    vi.mocked(drive.findJsonFile).mockResolvedValue('settings-file')
    vi.mocked(drive.readJsonFile).mockResolvedValue(baseSettings)
    const sess = makeSession()

    await getS3Settings('tok', 'sid', sess, {} as any)
    expect(drive.findJsonFile).toHaveBeenCalledTimes(1)
    expect(sess).toHaveProperty('s3_settings_file_id', 'settings-file')

    await getS3Settings('tok', 'sid', sess, {} as any)
    expect(drive.findJsonFile).toHaveBeenCalledTimes(1) // not called again
    expect(drive.readJsonFile).toHaveBeenCalledTimes(2) // content itself is always re-read fresh, never cached
  })

  it('re-looks-up the fileId once if the cached one 404s, instead of failing outright', async () => {
    // Simulates the user deleting s3_settings.json in Drive directly (or it
    // being recreated under a new id) — the cached fileId this session holds
    // is now stale.
    vi.mocked(drive.findJsonFile).mockResolvedValue('fresh-file')
    vi.mocked(drive.readJsonFile)
      .mockRejectedValueOnce(new DriveError(404, 'not_found'))
      .mockResolvedValueOnce(baseSettings)
    const sess = makeSession({ s3_settings_file_id: 'stale-file' })

    const result = await getS3Settings('tok', 'sid', sess, {} as any)

    expect(result).toEqual(baseSettings)
    expect(drive.findJsonFile).toHaveBeenCalledTimes(1)
    expect(sess.s3_settings_file_id).toBe('fresh-file')
  })

  it('re-looks-up the fileId when the cached one now points to a trashed file, instead of trusting its content', async () => {
    // Trashing s3_settings.json via Drive's own UI (the ordinary way to delete a file
    // there) is a soft delete — unlike a hard delete, reading a trashed file's content
    // via alt=media still succeeds instead of 404ing, so a cached fileId must be
    // checked against `trashed` explicitly or it would keep resolving to the old,
    // supposedly-disabled config indefinitely.
    vi.mocked(drive.getEntryMeta).mockResolvedValue({ id: 'stale-file', name: S3_SETTINGS_FILE_NAME, trashed: true } as any)
    vi.mocked(drive.findJsonFile).mockResolvedValue(null) // no other (non-trashed) settings file exists
    const sess = makeSession({ s3_settings_file_id: 'stale-file' })

    const result = await getS3Settings('tok', 'sid', sess, {} as any)

    expect(result).toBeNull()
    expect(drive.readJsonFile).not.toHaveBeenCalled()
    expect(sess.s3_settings_file_id).toBeUndefined()
  })
})

describe('credentialsCacheKey', () => {
  it('combines google_sub, roleArn, and region so it is unique per account', () => {
    const key = credentialsCacheKey(makeSession({ google_sub: '112233' }), baseSettings)
    expect(key).toBe(`112233:${baseSettings.roleArn}:${baseSettings.region}`)
  })

  it('omits the key (opts out of caching) when the session has no google_sub', () => {
    expect(credentialsCacheKey(makeSession(), baseSettings)).toBeUndefined()
  })
})

describe('mirrorEntrySave', () => {
  it('passes a per-account cache key through to assumeRoleWithWebIdentity', async () => {
    vi.mocked(drive.findJsonFile).mockResolvedValue('settings-file')
    vi.mocked(drive.readJsonFile).mockResolvedValue(baseSettings)
    const sess = makeSession({ google_sub: '112233' })

    await mirrorEntrySave('tok', 'sid', sess, {} as any, '2026-01-01', 'hello', 'file-1', '5')

    expect(s3.assumeRoleWithWebIdentity).toHaveBeenCalledWith(
      'id-token', baseSettings.roleArn, baseSettings.region, `112233:${baseSettings.roleArn}:${baseSettings.region}`,
    )
  })
})

describe('mirrorEntrySave (mirroring behavior)', () => {
  it('does nothing (and never touches Drive) when negatively cached', async () => {
    const sess = makeSession({ s3_settings_negative_cache_at: Date.now() })

    await mirrorEntrySave('tok', 'sid', sess, {} as any, '2026-01-01', 'hello', 'file-1', '5')

    expect(drive.findJsonFile).not.toHaveBeenCalled()
    expect(s3.assumeRoleWithWebIdentity).not.toHaveBeenCalled()
  })

  it('is a no-op when no settings file exists', async () => {
    const sess = makeSession()
    await mirrorEntrySave('tok', 'sid', sess, {} as any, '2026-01-01', 'hello', 'file-1', '5')
    expect(s3.assumeRoleWithWebIdentity).not.toHaveBeenCalled()
  })

  it('is a no-op when settings exist but are disabled', async () => {
    vi.mocked(drive.findJsonFile).mockResolvedValue('settings-file')
    vi.mocked(drive.readJsonFile).mockResolvedValue({ ...baseSettings, enabled: false })
    const sess = makeSession()
    await mirrorEntrySave('tok', 'sid', sess, {} as any, '2026-01-01', 'hello', 'file-1', '5')
    expect(s3.assumeRoleWithWebIdentity).not.toHaveBeenCalled()
  })

  it('mirrors the entry to S3 passing the Drive version through for ordering', async () => {
    vi.mocked(drive.findJsonFile).mockResolvedValue('settings-file')
    vi.mocked(drive.readJsonFile).mockResolvedValue(baseSettings)
    const sess = makeSession()

    await mirrorEntrySave('tok', 'sid', sess, {} as any, '2026-01-01', 'hello', 'file-1', '5')

    expect(s3.putObjectIfNewer).toHaveBeenCalledWith(
      { accessKeyId: 'ak', secretAccessKey: 'sk', sessionToken: 'st' },
      'my-bucket', 'us-east-1', 'diary-2026-01-01.txt', 'hello', '5',
    )
  })

  it('clears a previously recorded sync error once a mirror succeeds', async () => {
    vi.mocked(drive.findJsonFile).mockResolvedValue('settings-file')
    vi.mocked(drive.readJsonFile).mockResolvedValue({ ...baseSettings, lastSyncError: 'old failure', lastSyncErrorAt: '2026-01-01T00:00:00.000Z' })
    const sess = makeSession()

    await mirrorEntrySave('tok', 'sid', sess, {} as any, '2026-01-02', 'hello', 'file-1', '6')

    expect(drive.writeJsonFile).toHaveBeenCalledWith('tok', 'folder-1', S3_SETTINGS_FILE_NAME, baseSettings, 'settings-file')
  })

  it('does not rewrite the settings file when the mirror succeeds and there was no prior error', async () => {
    vi.mocked(drive.findJsonFile).mockResolvedValue('settings-file')
    vi.mocked(drive.readJsonFile).mockResolvedValue(baseSettings)
    const sess = makeSession()

    await mirrorEntrySave('tok', 'sid', sess, {} as any, '2026-01-02', 'hello', 'file-1', '6')

    expect(drive.writeJsonFile).not.toHaveBeenCalled()
  })

  it('records a sync error when the mirror fails, without throwing', async () => {
    vi.mocked(drive.findJsonFile).mockResolvedValue('settings-file')
    vi.mocked(drive.readJsonFile).mockResolvedValue(baseSettings)
    vi.mocked(s3.putObjectIfNewer).mockRejectedValue(new s3.S3Error(403, 'AccessDenied'))
    const sess = makeSession()

    await expect(mirrorEntrySave('tok', 'sid', sess, {} as any, '2026-01-01', 'hello', 'file-1', '5')).resolves.toBeUndefined()

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

    await mirrorEntrySave('tok', 'sid', sess, {} as any, '2026-01-01', 'hello', 'file-1', '5')

    expect(drive.writeJsonFile).not.toHaveBeenCalled()
  })

  it('records a sync error when there is no valid Google ID token', async () => {
    vi.mocked(drive.findJsonFile).mockResolvedValue('settings-file')
    vi.mocked(drive.readJsonFile).mockResolvedValue(baseSettings)
    vi.mocked(session.getValidIdToken).mockResolvedValue(null)
    const sess = makeSession()

    await mirrorEntrySave('tok', 'sid', sess, {} as any, '2026-01-01', 'hello', 'file-1', '5')

    expect(s3.assumeRoleWithWebIdentity).not.toHaveBeenCalled()
    expect(drive.writeJsonFile).toHaveBeenCalledWith(
      'tok', 'folder-1', S3_SETTINGS_FILE_NAME,
      expect.objectContaining({ lastSyncError: expect.stringContaining('sign out') }),
      'settings-file',
    )
  })
})

describe('mirrorEntrySave ghost-object compensation', () => {
  // A slower save's mirror can complete after a faster concurrent delete's mirror
  // already removed the object (both fire as independent context.waitUntil tasks
  // with no ordering guarantee) — that would resurrect a deleted entry in the S3
  // backup. mirrorEntrySave re-checks Drive after writing and self-heals.
  it('deletes the just-written mirror when Drive no longer has the entry', async () => {
    vi.mocked(drive.findJsonFile).mockResolvedValue('settings-file')
    vi.mocked(drive.readJsonFile).mockResolvedValue(baseSettings)
    vi.mocked(drive.getDiaryFileMeta).mockRejectedValue(new DriveError(404, 'not_found'))
    const sess = makeSession()

    await mirrorEntrySave('tok', 'sid', sess, {} as any, '2026-01-01', 'hello', 'file-1', '5')

    expect(s3.putObjectIfNewer).toHaveBeenCalled()
    expect(s3.deleteObject).toHaveBeenCalledWith(
      { accessKeyId: 'ak', secretAccessKey: 'sk', sessionToken: 'st' },
      'my-bucket', 'us-east-1', 'diary-2026-01-01.txt',
    )
  })

  it('keeps the mirror when Drive still has the entry (happy path)', async () => {
    vi.mocked(drive.findJsonFile).mockResolvedValue('settings-file')
    vi.mocked(drive.readJsonFile).mockResolvedValue(baseSettings)
    vi.mocked(drive.getDiaryFileMeta).mockResolvedValue({ id: 'file-1', name: 'diary-2026-01-01.txt' } as any)
    const sess = makeSession()

    await mirrorEntrySave('tok', 'sid', sess, {} as any, '2026-01-01', 'hello', 'file-1', '5')

    expect(s3.deleteObject).not.toHaveBeenCalled()
  })

  it('does not delete the mirror when the existence re-check itself fails ambiguously', async () => {
    vi.mocked(drive.findJsonFile).mockResolvedValue('settings-file')
    vi.mocked(drive.readJsonFile).mockResolvedValue(baseSettings)
    vi.mocked(drive.getDiaryFileMeta).mockRejectedValue(new Error('network blip'))
    const sess = makeSession()

    await mirrorEntrySave('tok', 'sid', sess, {} as any, '2026-01-01', 'hello', 'file-1', '5')

    expect(s3.deleteObject).not.toHaveBeenCalled()
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

describe('resyncSingleEntry', () => {
  it('mirrors the entry and clears it from a finished backfill\'s failed list', async () => {
    const settings = {
      ...baseSettings,
      backfillProgress: { total: 5, done: 5, failed: ['2026-01-01'], finishedAt: '2026-01-01T00:00:00.000Z' },
    }
    vi.mocked(drive.readJsonFile).mockResolvedValue(settings)

    const result = await resyncSingleEntry('tok', 'sid', makeSession(), {} as any, settings, 'folder-1', 'settings-file', '2026-01-01')

    expect(result).toEqual({ ok: true })
    expect(s3.putObjectIfNewer).toHaveBeenCalledWith(
      { accessKeyId: 'ak', secretAccessKey: 'sk', sessionToken: 'st' },
      'my-bucket', 'us-east-1', 'diary-2026-01-01.txt', 'hello', '5',
    )
    const [, , , written] = vi.mocked(drive.writeJsonFile).mock.calls.at(-1)!
    // Was the only failed date and the run had already finished — fully cleared,
    // same terminal state finishBackfill leaves when every entry succeeds.
    expect(written).not.toHaveProperty('backfillProgress')
  })

  it('does not touch total/done/remaining/finishedAt of a backfill that is still actively running (regression: used to falsely finish it)', async () => {
    // The exact scenario this fix closes: a 500-entry backfill is 120 done, 380 still
    // outstanding in `remaining`, when the user retries one specific failed date from
    // its badge. The old code reused backfillAllEntries for this, which unconditionally
    // stamped finishedAt (and done: total) over the whole record — truncating the run.
    const activeProgress = {
      total: 500, done: 120, failed: ['2026-01-01', '2026-02-14'],
      remaining: Array.from({ length: 380 }, (_, i) => `date-${i}`),
    }
    const settings = { ...baseSettings, backfillProgress: activeProgress }
    vi.mocked(drive.readJsonFile).mockResolvedValue(settings)

    const result = await resyncSingleEntry('tok', 'sid', makeSession(), {} as any, settings, 'folder-1', 'settings-file', '2026-01-01')

    expect(result).toEqual({ ok: true })
    const [, , , written] = vi.mocked(drive.writeJsonFile).mock.calls.at(-1)!
    const bp = (written as any).backfillProgress
    expect(bp.finishedAt).toBeUndefined()
    expect(bp.total).toBe(500)
    expect(bp.done).toBe(120)
    expect(bp.remaining).toHaveLength(380)
    expect(bp.failed).toEqual(['2026-02-14']) // only the retried date was removed
  })

  it('does not write to Drive at all when the date was never recorded as failed and nothing else changed', async () => {
    const settings = { ...baseSettings }
    vi.mocked(drive.readJsonFile).mockResolvedValue(settings)

    await resyncSingleEntry('tok', 'sid', makeSession(), {} as any, settings, 'folder-1', 'settings-file', '2026-01-01')

    expect(drive.writeJsonFile).not.toHaveBeenCalled()
  })

  it('treats an entry no longer in Drive as nothing to back up, not a failure', async () => {
    vi.mocked(drive.findEntryMeta).mockResolvedValue(null)
    const settings = {
      ...baseSettings,
      backfillProgress: { total: 1, done: 1, failed: ['2026-01-01'], finishedAt: '2026-01-01T00:00:00.000Z' },
    }
    vi.mocked(drive.readJsonFile).mockResolvedValue(settings)

    const result = await resyncSingleEntry('tok', 'sid', makeSession(), {} as any, settings, 'folder-1', 'settings-file', '2026-01-01')

    expect(result).toEqual({ ok: true })
    expect(s3.putObjectIfNewer).not.toHaveBeenCalled()
  })

  it('records a failure and returns ok:false when the mirror fails, without touching an active backfillProgress', async () => {
    vi.mocked(s3.putObjectIfNewer).mockRejectedValue(new s3.S3Error(403, 'AccessDenied'))
    const activeProgress = { total: 5, done: 2, failed: ['2026-01-01'], remaining: ['x', 'y'] }
    const settings = { ...baseSettings, backfillProgress: activeProgress }
    vi.mocked(drive.readJsonFile).mockResolvedValue(settings)

    const result = await resyncSingleEntry('tok', 'sid', makeSession(), {} as any, settings, 'folder-1', 'settings-file', '2026-01-01')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('AccessDenied')
    const [, , , written] = vi.mocked(drive.writeJsonFile).mock.calls.at(-1)!
    expect((written as any).backfillProgress).toEqual(activeProgress)
    expect((written as any).lastSyncError).toContain('AccessDenied')
  })
})

describe('sync-status writes re-read config fresh before merging (Fix 1)', () => {
  // writeBackfillProgress/finishBackfill/recordMirrorFailure/recordMirrorSuccess run
  // concurrently with a user's own Save (settings.ts PUT), which can change `enabled`/
  // roleArn/bucket/region while a chunked backfill is still holding an older in-memory
  // snapshot. Blindly spreading that stale snapshot as the write's base would silently
  // resurrect the old config. These writers re-read the file immediately before writing
  // and merge only their own field(s) onto the fresh read instead.
  it('writeBackfillProgress merges onto a freshly re-read file, not the stale in-memory snapshot', async () => {
    const staleRecord: S3SettingsRecord = { settings: { ...baseSettings, enabled: true }, folderId: 'folder-1', fileId: 'settings-file' }
    // The user disabled S3 backup via Save while this chunk was in flight.
    vi.mocked(drive.readJsonFile).mockResolvedValue({ ...baseSettings, enabled: false })

    await writeBackfillProgress('tok', staleRecord, { total: 5, done: 3, failed: [], remaining: ['x'] })

    const [, , , written] = vi.mocked(drive.writeJsonFile).mock.calls.at(-1)!
    expect((written as any).enabled).toBe(false)
    expect((written as any).backfillProgress).toEqual({ total: 5, done: 3, failed: [], remaining: ['x'] })
  })

  it('finishBackfill merges onto a freshly re-read file, not the stale in-memory snapshot', async () => {
    const staleRecord: S3SettingsRecord = { settings: { ...baseSettings, bucket: 'old-bucket' }, folderId: 'folder-1', fileId: 'settings-file' }
    // The user changed the bucket via Save while this chunk was in flight.
    vi.mocked(drive.readJsonFile).mockResolvedValue({ ...baseSettings, bucket: 'new-bucket' })

    await finishBackfill('tok', staleRecord, 5, [], 'Resync')

    const [, , , written] = vi.mocked(drive.writeJsonFile).mock.calls.at(-1)!
    expect((written as any).bucket).toBe('new-bucket')
  })

  it('falls back to the in-memory snapshot when the fresh re-read fails', async () => {
    const staleRecord: S3SettingsRecord = { settings: { ...baseSettings }, folderId: 'folder-1', fileId: 'settings-file' }
    vi.mocked(drive.readJsonFile).mockRejectedValue(new Error('Drive is down'))

    await writeBackfillProgress('tok', staleRecord, { total: 1, done: 1, failed: [], remaining: [] })

    const [, , , written] = vi.mocked(drive.writeJsonFile).mock.calls.at(-1)!
    expect((written as any).bucket).toBe(baseSettings.bucket)
    expect((written as any).backfillProgress).toEqual({ total: 1, done: 1, failed: [], remaining: [] })
  })

  it('mirrorEntrySave failure recording also merges onto a freshly re-read file', async () => {
    vi.mocked(drive.findJsonFile).mockResolvedValue('settings-file')
    // First read (loadS3SettingsRecord, at the start of mirrorEntrySave) sees the old
    // config; a second, later read (the re-read-merge inside recordMirrorFailure) sees
    // what the user just changed it to via a concurrent Save.
    vi.mocked(drive.readJsonFile)
      .mockResolvedValueOnce({ ...baseSettings, bucket: 'old-bucket' })
      .mockResolvedValue({ ...baseSettings, bucket: 'new-bucket' })
    vi.mocked(s3.putObjectIfNewer).mockRejectedValue(new s3.S3Error(403, 'AccessDenied'))
    const sess = makeSession()

    await mirrorEntrySave('tok', 'sid', sess, {} as any, '2026-01-01', 'hello', 'file-1', '5')

    const [, , , written] = vi.mocked(drive.writeJsonFile).mock.calls.at(-1)!
    expect((written as any).bucket).toBe('new-bucket')
    expect((written as any).lastSyncError).toEqual(expect.stringContaining('AccessDenied'))
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

  it('skips an entry whose mirror fails and continues to the rest, recording it in backfillProgress.failed', async () => {
    vi.mocked(drive.listEntries).mockResolvedValue([
      { id: 'f1', name: 'diary-2026-01-01.txt', version: '1' },
      { id: 'f2', name: 'diary-2026-01-02.txt', version: '2' },
    ] as any)
    vi.mocked(drive.getEntryContent).mockImplementation(async (_tok, fileId) => {
      if (fileId === 'f1') throw new Error('S3 hiccup')
      return { date: '', content: 'day two' }
    })
    const sess = makeSession()

    await backfillAllEntries('tok', 'sid', sess, {} as any, baseSettings, 'folder-1', 'settings-file')

    // Both entries were attempted despite the first one failing.
    expect(s3.putObjectIfNewer).toHaveBeenCalledWith(expect.anything(), 'my-bucket', 'us-east-1', 'diary-2026-01-02.txt', 'day two', '2')
    expect(drive.writeJsonFile).toHaveBeenLastCalledWith(
      'tok', 'folder-1', S3_SETTINGS_FILE_NAME,
      expect.objectContaining({
        backfillProgress: expect.objectContaining({ total: 2, done: 2, failed: ['2026-01-01'] }),
        lastSyncError: expect.stringContaining('1 of 2'),
      }),
      'settings-file',
    )
  })

  it('only processes dates in onlyDates when given (a retry of previously-failed entries)', async () => {
    vi.mocked(drive.listEntries).mockResolvedValue([
      { id: 'f1', name: 'diary-2026-01-01.txt', version: '1' },
      { id: 'f2', name: 'diary-2026-01-02.txt', version: '2' },
    ] as any)
    vi.mocked(drive.getEntryContent).mockResolvedValue({ date: '', content: 'day one' })
    const sess = makeSession()

    await backfillAllEntries('tok', 'sid', sess, {} as any, baseSettings, 'folder-1', 'settings-file', ['2026-01-01'])

    expect(drive.getEntryContent).toHaveBeenCalledOnce()
    expect(s3.putObjectIfNewer).toHaveBeenCalledWith(expect.anything(), 'my-bucket', 'us-east-1', 'diary-2026-01-01.txt', 'day one', '1')
    expect(s3.putObjectIfNewer).not.toHaveBeenCalledWith(expect.anything(), 'my-bucket', 'us-east-1', 'diary-2026-01-02.txt', expect.anything(), expect.anything())
  })

  it('uses the given runLabel in the recorded failure message instead of "Initial backfill"', async () => {
    vi.mocked(drive.listEntries).mockRejectedValue(new Error('Drive is down'))
    const sess = makeSession()

    await backfillAllEntries('tok', 'sid', sess, {} as any, baseSettings, 'folder-1', 'settings-file', undefined, 'Resync')

    expect(drive.writeJsonFile).toHaveBeenCalledWith(
      'tok', 'folder-1', S3_SETTINGS_FILE_NAME,
      expect.objectContaining({ lastSyncError: expect.stringMatching(/^Resync failed:/) }),
      'settings-file',
    )
  })

  it('clears backfillProgress and lastSyncError once every entry succeeds', async () => {
    vi.mocked(drive.listEntries).mockResolvedValue([
      { id: 'f1', name: 'diary-2026-01-01.txt', version: '1' },
    ] as any)
    vi.mocked(drive.getEntryContent).mockResolvedValue({ date: '', content: 'day one' })
    const sess = makeSession()

    await backfillAllEntries('tok', 'sid', sess, {} as any, {
      ...baseSettings,
      backfillProgress: { total: 1, done: 1, failed: ['2026-01-01'], finishedAt: '2026-01-01T00:00:00.000Z' },
      lastSyncError: 'Initial backfill: 1 of 1 entry failed to back up',
      lastSyncErrorAt: '2026-01-01T00:00:00.000Z',
    }, 'folder-1', 'settings-file')

    const [, , , updated] = vi.mocked(drive.writeJsonFile).mock.calls.at(-1)!
    expect(updated).not.toHaveProperty('backfillProgress')
    expect(updated).not.toHaveProperty('lastSyncError')
    expect(updated).not.toHaveProperty('lastSyncErrorAt')
  })

  it('resets baseDone to 0 on a full resync (onlyDates undefined) even with stale progress', async () => {
    vi.mocked(drive.listEntries).mockResolvedValue([
      { id: 'f1', name: 'diary-2026-01-01.txt', version: '1' },
      { id: 'f2', name: 'diary-2026-01-02.txt', version: '2' },
      { id: 'f3', name: 'diary-2026-01-03.txt', version: '3' },
    ] as any)
    vi.mocked(drive.getEntryContent).mockResolvedValue({ date: '', content: 'day' })
    const sess = makeSession()

    // Stale progress from a previous backfill: done=2 out of 3
    const staleProgress = { total: 3, done: 2, failed: [] as string[] }
    await backfillAllEntries('tok', 'sid', sess, {} as any, {
      ...baseSettings, backfillProgress: staleProgress,
    }, 'folder-1', 'settings-file', undefined, 'Resync')

    // All three entries should have been processed (not just the remaining 1)
    expect(s3.putObjectIfNewer).toHaveBeenCalledTimes(3)

    // Progress total should be 3 (actual entry count), and finishBackfill
    // should have been called (clearing backfillProgress) since all entries succeeded.
    const lastWrite = vi.mocked(drive.writeJsonFile).mock.calls.at(-1)!
    const updated = lastWrite[3] as any
    expect(updated).not.toHaveProperty('backfillProgress')
  })

  it('uses allEntries.length as totalAll on a full resync, not the stale progress total', async () => {
    vi.mocked(drive.listEntries).mockResolvedValue([
      { id: 'f1', name: 'diary-2026-01-01.txt', version: '1' },
      { id: 'f2', name: 'diary-2026-01-02.txt', version: '2' },
    ] as any)
    vi.mocked(drive.getEntryContent).mockResolvedValue({ date: '', content: 'day' })
    const sess = makeSession()

    // Stale progress claims total=5 but only 2 entries exist now
    await backfillAllEntries('tok', 'sid', sess, {} as any, {
      ...baseSettings, backfillProgress: { total: 5, done: 3, failed: [] },
    }, 'folder-1', 'settings-file', undefined, 'Resync')

    const progressWrite = vi.mocked(drive.writeJsonFile).mock.calls.find(
      ([, , name, body]) => name === 's3_settings.json' && (body as any).backfillProgress,
    )
    expect(progressWrite).toBeDefined()
    const written = progressWrite![3] as any
    // total should be 2 (actual entries), not 5 (stale progress)
    expect(written.backfillProgress.total).toBe(2)
  })

  it('carries over progress when onlyDates is given (retry/continue)', async () => {
    vi.mocked(drive.listEntries).mockResolvedValue([
      { id: 'f1', name: 'diary-2026-01-01.txt', version: '1' },
      { id: 'f2', name: 'diary-2026-01-02.txt', version: '2' },
      { id: 'f3', name: 'diary-2026-01-03.txt', version: '3' },
    ] as any)
    vi.mocked(drive.getEntryContent).mockResolvedValue({ date: '', content: 'day' })
    const sess = makeSession()

    // Only retry the third entry (previously failed), progress says done=2 of 3
    await backfillAllEntries('tok', 'sid', sess, {} as any, {
      ...baseSettings, backfillProgress: { total: 3, done: 2, failed: ['2026-01-03'] },
    }, 'folder-1', 'settings-file', ['2026-01-03'])

    // Only one entry processed (the failed one)
    expect(s3.putObjectIfNewer).toHaveBeenCalledTimes(1)
    expect(s3.putObjectIfNewer).toHaveBeenCalledWith(expect.anything(), 'my-bucket', 'us-east-1', 'diary-2026-01-03.txt', 'day', '3')

    // Progress should carry over: done=3 (baseDone=2 + 1 processed)
    const progressWrite = vi.mocked(drive.writeJsonFile).mock.calls.find(
      ([, , name, body]) => name === 's3_settings.json' && (body as any).backfillProgress,
    )
    expect(progressWrite).toBeDefined()
    const written = progressWrite![3] as any
    expect(written.backfillProgress).toEqual(expect.objectContaining({ total: 3, done: 3 }))
  })

  it('persists `remaining` as the scope not yet attempted, chunked by chunkSize', async () => {
    vi.mocked(drive.listEntries).mockResolvedValue([
      { id: 'f1', name: 'diary-2026-01-01.txt', version: '1' },
      { id: 'f2', name: 'diary-2026-01-02.txt', version: '2' },
      { id: 'f3', name: 'diary-2026-01-03.txt', version: '3' },
    ] as any)
    vi.mocked(drive.getEntryContent).mockResolvedValue({ date: '', content: 'day' })
    const sess = makeSession()

    await backfillAllEntries('tok', 'sid', sess, {} as any, baseSettings, 'folder-1', 'settings-file', undefined, 'Initial backfill', 2)

    // Only the first 2 of 3 dates should have been processed this invocation.
    expect(s3.putObjectIfNewer).toHaveBeenCalledTimes(2)
    const lastWrite = vi.mocked(drive.writeJsonFile).mock.calls.at(-1)!
    const updated = lastWrite[3] as any
    expect(updated.backfillProgress).toEqual(expect.objectContaining({ total: 3, done: 2, remaining: ['2026-01-03'] }))
  })

  it('does not skip a target date that a concurrent Drive delete removed from a different position (delete-before-cursor regression)', async () => {
    // Continuation call: onlyDates is exactly the persisted `remaining` from a prior chunk.
    // 2026-01-02 (mid-scope) was deleted from Drive in between chunks — it must be dropped
    // from remaining (nothing to back up) WITHOUT shifting/skipping 2026-01-03, which is
    // what a positional-slice-over-a-refreshed-listing implementation would do.
    vi.mocked(drive.listEntries).mockResolvedValue([
      { id: 'f1', name: 'diary-2026-01-01.txt', version: '1' }, // already done, not in this chunk
      { id: 'f3', name: 'diary-2026-01-03.txt', version: '3' }, // 02 is gone
    ] as any)
    vi.mocked(drive.getEntryContent).mockResolvedValue({ date: '', content: 'day' })
    const sess = makeSession()

    await backfillAllEntries(
      'tok', 'sid', sess, {} as any,
      { ...baseSettings, backfillProgress: { total: 3, done: 1, failed: [], remaining: ['2026-01-02', '2026-01-03'] } },
      'folder-1', 'settings-file', ['2026-01-02', '2026-01-03'], 'Backfill', 20,
    )

    // 2026-01-03 must still be mirrored despite 02's disappearance shifting Drive's listing.
    expect(s3.putObjectIfNewer).toHaveBeenCalledWith(expect.anything(), 'my-bucket', 'us-east-1', 'diary-2026-01-03.txt', 'day', '3')
    // The deleted date is not recorded as a failure — there's nothing to back up for it.
    const lastWrite = vi.mocked(drive.writeJsonFile).mock.calls.at(-1)!
    const updated = lastWrite[3] as any
    expect(updated.backfillProgress?.failed ?? []).not.toContain('2026-01-02')
  })

  it('starts a fresh resync from done=0 even when the previous backfill had failures', async () => {
    vi.mocked(drive.listEntries).mockResolvedValue([
      { id: 'f1', name: 'diary-2026-01-01.txt', version: '1' },
    ] as any)
    vi.mocked(drive.getEntryContent).mockResolvedValue({ date: '', content: 'day' })
    const sess = makeSession()

    // Previous backfill finished with a failure
    await backfillAllEntries('tok', 'sid', sess, {} as any, {
      ...baseSettings,
      backfillProgress: { total: 3, done: 3, failed: ['2026-01-01'], finishedAt: '2026-01-01T00:00:00.000Z' },
    }, 'folder-1', 'settings-file', undefined, 'Resync')

    // The single entry is processed and succeeds
    expect(s3.putObjectIfNewer).toHaveBeenCalledOnce()

    // failed list should be cleared (entry succeeded this time), not carried over
    const lastWrite = vi.mocked(drive.writeJsonFile).mock.calls.at(-1)!
    const updated = lastWrite[3] as any
    expect(updated).not.toHaveProperty('backfillProgress')
  })
})
