import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  S3_BUCKET_RE, S3_SETTINGS_NEGATIVE_CACHE_MS, S3_SETTINGS_FILE_NAME, S3_SYNC_STATUS_FILE_NAME,
  isValidS3Settings, getS3Settings, loadS3SettingsRecord, mirrorEntrySave, mirrorEntryDelete, backfillAllEntries,
  writeBackfillProgress, finishBackfill, resyncSingleEntry, isBackfillRunActive,
  getAssumedCredentials, reconcileS3Entry,
} from '../../functions/_shared/s3Settings'
import type { S3SettingsRecord, S3Config, S3SyncStatus } from '../../functions/_shared/s3Settings'
import * as drive from '../../functions/_shared/drive'
import { DriveError } from '../../functions/_shared/drive'
import * as session from '../../functions/_shared/session'
import * as s3 from '../../functions/_shared/s3'
import type { SessionData } from '../../functions/_shared/session'

// A fixed value rather than Date.now()-derived so the mock setup (beforeEach) and
// assertions that check what assumeRoleWithWebIdentity's caller passed downstream
// (toHaveBeenCalledWith) always agree, instead of drifting by whatever milliseconds
// elapsed between the two Date.now() calls.
const { MOCK_CREDS_EXPIRES_AT } = vi.hoisted(() => ({ MOCK_CREDS_EXPIRES_AT: Date.parse('2026-06-01T00:00:00.000Z') }))

vi.mock('../../functions/_shared/drive', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../functions/_shared/drive')>()),
  ensureFolder: vi.fn().mockResolvedValue('folder-1'),
  findJsonFile: vi.fn().mockResolvedValue(null),
  readJsonFile: vi.fn(),
  writeJsonFile: vi.fn(),
  listEntries: vi.fn().mockResolvedValue([]),
  getEntryContent: vi.fn(),
  getDiaryFileMeta: vi.fn(),
  getEntryMeta: vi.fn(),
  findCurrentEntryMeta: vi.fn(),
}))

vi.mock('../../functions/_shared/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../functions/_shared/session')>()),
  getValidIdToken: vi.fn().mockResolvedValue('id-token'),
  saveSession: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../functions/_shared/s3', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../functions/_shared/s3')>()),
  assumeRoleWithWebIdentity: vi.fn().mockResolvedValue({ accessKeyId: 'ak', secretAccessKey: 'sk', sessionToken: 'st', expiresAt: MOCK_CREDS_EXPIRES_AT }),
  putObjectIfNewer: vi.fn().mockResolvedValue(undefined),
  deleteObject: vi.fn().mockResolvedValue(undefined),
}))

const baseSettings = { enabled: true, roleArn: 'arn:aws:iam::123456789012:role/linger-s3', bucket: 'my-bucket', region: 'us-east-1' }

const CONFIG_FILE_ID = 'settings-file'
const STATUS_FILE_ID = 'status-file'
let persistedStatus: S3SyncStatus = {}

function makeSession(overrides: Partial<SessionData> = {}): SessionData {
  return { access_token: 'at', expires_at: Date.now() + 100_000, ...overrides }
}

// Config (s3_settings.json) and status (s3_sync_status.json) are two separate Drive
// files (see s3Settings.ts's S3SettingsRecord) — findJsonFile is keyed by filename and
// readJsonFile by fileId, same as the real Drive API, so resolving one can never bleed
// into the other the way a single blanket mock would. Pass `null` for either to
// simulate that file not existing yet.
function mockS3Files(config: unknown | null, status: unknown | null = null): void {
  vi.mocked(drive.findJsonFile).mockImplementation(async (_t, _f, fileName) => {
    if (fileName === S3_SETTINGS_FILE_NAME) return config === null ? null : CONFIG_FILE_ID
    if (fileName === S3_SYNC_STATUS_FILE_NAME) return status === null ? null : STATUS_FILE_ID
    return null
  })
  vi.mocked(drive.readJsonFile).mockImplementation(async (_t, fileId) => {
    if (fileId === CONFIG_FILE_ID && config !== null) return config
    if (fileId === STATUS_FILE_ID && status !== null) return status
    throw new DriveError(404, 'not_found')
  })
}

// Builds an S3SettingsRecord the way loadS3SettingsRecord would, for tests that call
// backfillAllEntries/resyncSingleEntry/writeBackfillProgress/finishBackfill directly
// rather than through a route handler.
function makeRecord(config: Partial<S3Config> = {}, status: S3SyncStatus = {}, opts: { statusFileId?: string | null } = {}): S3SettingsRecord {
  persistedStatus = status
  return {
    config: { ...baseSettings, ...config },
    status,
    folderId: 'folder-1',
    configFileId: CONFIG_FILE_ID,
    statusFileId: opts.statusFileId === undefined ? STATUS_FILE_ID : opts.statusFileId,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(drive.ensureFolder).mockResolvedValue('folder-1')
  vi.mocked(drive.findJsonFile).mockResolvedValue(null)
  persistedStatus = {}
  vi.mocked(drive.listEntries).mockResolvedValue([])
  vi.mocked(drive.readJsonFile).mockImplementation(async () => persistedStatus)
  // Echoes back a fresh id per file (create) or the existing one (update) — no
  // `version` field by default, which keeps withFreshS3Status's optimistic-concurrency
  // check out of the way for tests that aren't specifically exercising it (see the
  // dedicated 'withFreshS3Status concurrency' describe block below).
  vi.mocked(drive.writeJsonFile).mockImplementation(async (_t, _f, fileName, body, existingFileId) => {
    if (fileName === S3_SYNC_STATUS_FILE_NAME) persistedStatus = body as S3SyncStatus
    return { id: existingFileId ?? (fileName === S3_SETTINGS_FILE_NAME ? CONFIG_FILE_ID : STATUS_FILE_ID), name: fileName }
  })
  vi.mocked(session.getValidIdToken).mockResolvedValue('id-token')
  vi.mocked(s3.assumeRoleWithWebIdentity).mockResolvedValue({ accessKeyId: 'ak', secretAccessKey: 'sk', sessionToken: 'st', expiresAt: MOCK_CREDS_EXPIRES_AT })
  vi.mocked(s3.putObjectIfNewer).mockResolvedValue(undefined)
  vi.mocked(s3.deleteObject).mockResolvedValue(undefined)
  // Default: the entry still exists in Drive post-save (the common case) — no compensating delete.
  vi.mocked(drive.getDiaryFileMeta).mockResolvedValue({ id: 'file-1', name: 'diary-2026-01-01.txt' } as any)
  // Default: a cached fileId still points to a live (non-trashed) file, with no `version`
  // (see writeJsonFile's mock above for why).
  vi.mocked(drive.getEntryMeta).mockResolvedValue({ id: CONFIG_FILE_ID, name: S3_SETTINGS_FILE_NAME, trashed: false } as any)
  vi.mocked(drive.findCurrentEntryMeta).mockResolvedValue({ id: 'file-1', name: 'diary-2026-01-01.txt', version: '5' } as any)
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
  it('reconciles folder-scoped IDs and negative caches before loading settings', async () => {
    mockS3Files(baseSettings, null)
    const sess = makeSession({
      folder_id: 'old-folder',
      s3_settings_file_id: 'old-settings-file',
      s3_status_file_id: 'old-status-file',
      s3_settings_negative_cache_at: Date.now(),
      s3_status_negative_cache_at: Date.now(),
    })
    vi.mocked(drive.ensureFolder).mockImplementation(async (_token, _sessionId, current) => {
      session.invalidateFolderScopedS3Cache(current)
      current.folder_id = 'canonical-folder'
      return 'canonical-folder'
    })

    const result = await loadS3SettingsRecord('tok', 'sid', sess, {} as any)

    expect(result?.folderId).toBe('canonical-folder')
    expect(result?.configFileId).toBe(CONFIG_FILE_ID)
    expect(drive.findJsonFile).toHaveBeenCalledWith('tok', 'canonical-folder', S3_SETTINGS_FILE_NAME)
    expect(drive.readJsonFile).toHaveBeenCalledWith('tok', CONFIG_FILE_ID)
    expect(sess.s3_settings_file_id).toBe(CONFIG_FILE_ID)
    expect(sess.s3_settings_negative_cache_at).toBeUndefined()
  })

  it('caches the "no settings file" result on the session so the next call skips the Drive lookup', async () => {
    mockS3Files(null, null)
    const sess = makeSession()

    const first = await getS3Settings('tok', 'sid', sess, {} as any)
    expect(first).toBeNull()
    // Config and status are resolved concurrently (see loadS3SettingsRecord) rather
    // than status only being looked up once config is known to exist — so both
    // findJsonFile calls happen even though config turns out to be missing.
    expect(drive.findJsonFile).toHaveBeenCalledTimes(2)
    expect(sess).toHaveProperty('s3_settings_negative_cache_at')

    const second = await getS3Settings('tok', 'sid', sess, {} as any)
    expect(second).toBeNull()
    expect(drive.findJsonFile).toHaveBeenCalledTimes(2) // not called again — short-circuited by the negative cache
  })

  it('re-checks Drive once the negative cache has expired', async () => {
    mockS3Files(null, null)
    const sess = makeSession({ s3_settings_negative_cache_at: Date.now() - S3_SETTINGS_NEGATIVE_CACHE_MS - 1 })

    await getS3Settings('tok', 'sid', sess, {} as any)

    expect(drive.findJsonFile).toHaveBeenCalledTimes(2)
  })

  it('does not cache negatively when a settings file is found', async () => {
    mockS3Files(baseSettings, null)
    const sess = makeSession()

    const result = await getS3Settings('tok', 'sid', sess, {} as any)

    expect(result).toEqual(baseSettings) // status is {} (no status file yet), so the merge equals baseSettings exactly
    expect(sess).not.toHaveProperty('s3_settings_negative_cache_at')
  })

  it('negatively caches a missing status file separately, and does not re-check it once cached', async () => {
    mockS3Files(baseSettings, null)
    const sess = makeSession()

    await getS3Settings('tok', 'sid', sess, {} as any)
    expect(sess).toHaveProperty('s3_status_negative_cache_at')
    expect(drive.findJsonFile).toHaveBeenCalledTimes(2) // config + status, both looked up once

    await getS3Settings('tok', 'sid', sess, {} as any)
    // Config uses its cached fileId (still just a liveness check, no files.list); status
    // is negatively cached too, so neither lookup repeats.
    expect(drive.findJsonFile).toHaveBeenCalledTimes(2)
  })
})

describe('getS3Settings fileId caching', () => {
  it('caches the settings fileId on the session so a second call skips the files.list lookup', async () => {
    mockS3Files(baseSettings, { lastSyncError: 'boom' })
    const sess = makeSession()

    await getS3Settings('tok', 'sid', sess, {} as any)
    expect(drive.findJsonFile).toHaveBeenCalledTimes(2) // config + status, neither cached yet
    expect(sess).toHaveProperty('s3_settings_file_id', CONFIG_FILE_ID)
    expect(sess).toHaveProperty('s3_status_file_id', STATUS_FILE_ID)

    await getS3Settings('tok', 'sid', sess, {} as any)
    expect(drive.findJsonFile).toHaveBeenCalledTimes(2) // not called again — both fileIds now cached
    expect(drive.readJsonFile).toHaveBeenCalledTimes(4) // content itself is always re-read fresh, never cached: 2 files x 2 calls
  })

  it('re-looks-up the fileId once if the cached one 404s, instead of failing outright', async () => {
    // Simulates the user deleting s3_settings.json in Drive directly (or it
    // being recreated under a new id) — the cached fileId this session holds
    // is now stale.
    vi.mocked(drive.findJsonFile).mockImplementation(async (_t, _f, fileName) =>
      fileName === S3_SETTINGS_FILE_NAME ? 'fresh-file' : null)
    vi.mocked(drive.readJsonFile)
      .mockRejectedValueOnce(new DriveError(404, 'not_found'))
      .mockResolvedValueOnce(baseSettings)
    const sess = makeSession({ s3_settings_file_id: 'stale-file' })

    const result = await getS3Settings('tok', 'sid', sess, {} as any)

    expect(result).toEqual(baseSettings)
    expect(drive.findJsonFile).toHaveBeenCalledWith('tok', 'folder-1', S3_SETTINGS_FILE_NAME)
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

describe('getAssumedCredentials request scope', () => {
  it('assumes fresh credentials per operation without mutating or saving them in the session', async () => {
    const sess = makeSession({ google_sub: '112233' })
    const before = { ...sess }

    const first = await getAssumedCredentials('id-token', 'sid', sess, {} as any, baseSettings)
    const second = await getAssumedCredentials('id-token', 'sid', sess, {} as any, baseSettings)

    expect(first).toEqual({ accessKeyId: 'ak', secretAccessKey: 'sk', sessionToken: 'st', expiresAt: MOCK_CREDS_EXPIRES_AT })
    expect(second).toEqual(first)
    expect(s3.assumeRoleWithWebIdentity).toHaveBeenNthCalledWith(1, 'id-token', baseSettings.roleArn, baseSettings.region)
    expect(s3.assumeRoleWithWebIdentity).toHaveBeenNthCalledWith(2, 'id-token', baseSettings.roleArn, baseSettings.region)
    expect(sess).toEqual(before)
    expect(session.saveSession).not.toHaveBeenCalled()
  })
})

describe('save/delete backup delegation', () => {
  it('uses the same account coordinator for saves and delayed deletes, without stale content', async () => {
    const backup = vi.fn(async () => new Response('{}'))
    const env = { S3_WORKFLOW_SERVICE: { backup } } as any
    const sess = makeSession({ user_id: 'account', vault_key: 'request-key', id_token: 'id-token' })
    await mirrorEntrySave('tok', 'sid', sess, env, '2026-01-01', 'stale text', 'old-file', '100')
    await mirrorEntryDelete('tok', 'sid', sess, env, '2026-01-01')
    expect(backup).toHaveBeenCalledTimes(2)
    expect(backup.mock.calls[0]).toEqual(backup.mock.calls[1])
    expect(backup).toHaveBeenCalledWith(expect.objectContaining({
      accountKey: 'account', vaultKey: 'request-key', accessToken: 'tok',
      operation: { kind: 'reconcile', date: '2026-01-01' },
    }))
    expect(s3.putObjectIfNewer).not.toHaveBeenCalled()
    expect(s3.deleteObject).not.toHaveBeenCalled()
  })
  it('does not perform uncoordinated S3 writes if the coordinator is missing', async () => {
    mockS3Files(baseSettings)
    await mirrorEntrySave('tok', 'sid', makeSession({ user_id: 'account' }), {} as any, '2026-01-01', 'text', 'file', '1')
    expect(s3.putObjectIfNewer).not.toHaveBeenCalled()
  })
})

const reconcileSavedEntry: typeof mirrorEntrySave = async (token, sid, session, env, date) => {
  const record = await loadS3SettingsRecord(token, sid, session, env)
  if (record?.config.enabled) await resyncSingleEntry(token, sid, session, env, record, date)
}

describe('common entry reconciliation status', () => {
  it('does nothing (and never touches Drive) when negatively cached', async () => {
    const sess = makeSession({ s3_settings_negative_cache_at: Date.now() })

    await reconcileSavedEntry('tok', 'sid', sess, {} as any, '2026-01-01', 'hello', 'file-1', '5')

    expect(drive.findJsonFile).not.toHaveBeenCalled()
    expect(s3.assumeRoleWithWebIdentity).not.toHaveBeenCalled()
  })

  it('is a no-op when no settings file exists', async () => {
    mockS3Files(null, null)
    const sess = makeSession()
    await reconcileSavedEntry('tok', 'sid', sess, {} as any, '2026-01-01', 'hello', 'file-1', '5')
    expect(s3.assumeRoleWithWebIdentity).not.toHaveBeenCalled()
  })

  it('is a no-op when settings exist but are disabled', async () => {
    mockS3Files({ ...baseSettings, enabled: false }, null)
    const sess = makeSession()
    await reconcileSavedEntry('tok', 'sid', sess, {} as any, '2026-01-01', 'hello', 'file-1', '5')
    expect(s3.assumeRoleWithWebIdentity).not.toHaveBeenCalled()
  })

  it('mirrors the entry to S3 passing the Drive version through for ordering', async () => {
    mockS3Files(baseSettings, null)
    const sess = makeSession()

    await reconcileSavedEntry('tok', 'sid', sess, {} as any, '2026-01-01', 'hello', 'file-1', '5')

    expect(s3.putObjectIfNewer).toHaveBeenCalledWith(
      { accessKeyId: 'ak', secretAccessKey: 'sk', sessionToken: 'st', expiresAt: MOCK_CREDS_EXPIRES_AT },
      'my-bucket', 'us-east-1', 'diary-2026-01-01.txt', 'hello', '5', undefined, { fileId: 'file-1' },
    )
  })

  it('clears a previously recorded sync error once a mirror succeeds', async () => {
    mockS3Files(baseSettings, { lastSyncError: 'old failure', lastSyncErrorAt: '2026-01-01T00:00:00.000Z' })
    const sess = makeSession()

    await reconcileSavedEntry('tok', 'sid', sess, {} as any, '2026-01-02', 'hello', 'file-1', '6')

    expect(drive.writeJsonFile).toHaveBeenCalledWith('tok', 'folder-1', S3_SYNC_STATUS_FILE_NAME, {}, STATUS_FILE_ID)
  })

  it('does not rewrite the status file when the mirror succeeds and there was no prior error', async () => {
    mockS3Files(baseSettings, null)
    const sess = makeSession()

    await reconcileSavedEntry('tok', 'sid', sess, {} as any, '2026-01-02', 'hello', 'file-1', '6')

    expect(drive.writeJsonFile).not.toHaveBeenCalled()
  })

  it('records a sync error (stamped with the failing date) when the mirror fails, without throwing', async () => {
    mockS3Files(baseSettings, null)
    vi.mocked(s3.putObjectIfNewer).mockRejectedValue(new s3.S3Error(403, 'AccessDenied'))
    const sess = makeSession()

    await expect(reconcileSavedEntry('tok', 'sid', sess, {} as any, '2026-01-01', 'hello', 'file-1', '5')).resolves.toBeUndefined()

    expect(drive.writeJsonFile).toHaveBeenCalledWith(
      'tok', 'folder-1', S3_SYNC_STATUS_FILE_NAME,
      expect.objectContaining({ lastSyncError: expect.stringContaining('AccessDenied'), lastSyncErrorDate: '2026-01-01' }),
      undefined, // no status file existed yet — created fresh
    )
  })

  it('does not rewrite the status file when the same failure repeats for the same date', async () => {
    mockS3Files(baseSettings, { lastSyncError: 'AccessDenied', lastSyncErrorAt: '2026-01-01T00:00:00.000Z', lastSyncErrorDate: '2026-01-01' })
    vi.mocked(s3.putObjectIfNewer).mockRejectedValue(new s3.S3Error(403, 'AccessDenied'))
    const sess = makeSession()

    await reconcileSavedEntry('tok', 'sid', sess, {} as any, '2026-01-01', 'hello', 'file-1', '5')

    expect(drive.writeJsonFile).not.toHaveBeenCalled()
  })

  it('rewrites (updating lastSyncErrorDate) when the same error message recurs for a different date', async () => {
    // Regression guard: the dedup check must compare date *and* message — comparing
    // message alone would let a second date's identical failure silently keep
    // pointing lastSyncErrorDate at the first, stale date.
    mockS3Files(baseSettings, { lastSyncError: 'AccessDenied', lastSyncErrorAt: '2026-01-01T00:00:00.000Z', lastSyncErrorDate: '2026-01-01' })
    vi.mocked(s3.putObjectIfNewer).mockRejectedValue(new s3.S3Error(403, 'AccessDenied'))
    const sess = makeSession()

    await reconcileSavedEntry('tok', 'sid', sess, {} as any, '2026-01-02', 'hello', 'file-1', '5')

    expect(drive.writeJsonFile).toHaveBeenCalledWith(
      'tok', 'folder-1', S3_SYNC_STATUS_FILE_NAME,
      expect.objectContaining({ lastSyncError: expect.stringContaining('AccessDenied'), lastSyncErrorDate: '2026-01-02' }),
      STATUS_FILE_ID,
    )
  })

  it('attaches the failing date to a legacy dateless error on the next occurrence, even if the message is unchanged', async () => {
    // Transitional case: status written before lastSyncErrorDate existed has no
    // date attached. The very next failure should stamp one on, so future
    // entry-status checks can correctly scope it — a one-time rewrite, not a bug.
    mockS3Files(baseSettings, { lastSyncError: 'AccessDenied', lastSyncErrorAt: '2026-01-01T00:00:00.000Z' })
    vi.mocked(s3.putObjectIfNewer).mockRejectedValue(new s3.S3Error(403, 'AccessDenied'))
    const sess = makeSession()

    await reconcileSavedEntry('tok', 'sid', sess, {} as any, '2026-01-01', 'hello', 'file-1', '5')

    expect(drive.writeJsonFile).toHaveBeenCalledWith(
      'tok', 'folder-1', S3_SYNC_STATUS_FILE_NAME,
      expect.objectContaining({ lastSyncError: expect.stringContaining('AccessDenied'), lastSyncErrorDate: '2026-01-01' }),
      STATUS_FILE_ID,
    )
  })

  it('does not clear a different date\'s recorded sync error when this date\'s mirror succeeds', async () => {
    mockS3Files(baseSettings, { lastSyncError: 'old failure', lastSyncErrorAt: '2026-01-01T00:00:00.000Z', lastSyncErrorDate: '2026-01-01' })
    const sess = makeSession()

    await reconcileSavedEntry('tok', 'sid', sess, {} as any, '2026-01-02', 'hello', 'file-1', '6')

    expect(drive.writeJsonFile).not.toHaveBeenCalled()
  })

  it('clears this date\'s own recorded sync error once its mirror succeeds', async () => {
    mockS3Files(baseSettings, { lastSyncError: 'old failure', lastSyncErrorAt: '2026-01-01T00:00:00.000Z', lastSyncErrorDate: '2026-01-01' })
    const sess = makeSession()

    await reconcileSavedEntry('tok', 'sid', sess, {} as any, '2026-01-01', 'hello', 'file-1', '6')

    expect(drive.writeJsonFile).toHaveBeenCalledWith('tok', 'folder-1', S3_SYNC_STATUS_FILE_NAME, {}, STATUS_FILE_ID)
  })

  it('records a sync error when there is no valid Google ID token', async () => {
    mockS3Files(baseSettings, null)
    vi.mocked(session.getValidIdToken).mockResolvedValue(null)
    const sess = makeSession()

    await reconcileSavedEntry('tok', 'sid', sess, {} as any, '2026-01-01', 'hello', 'file-1', '5')

    expect(s3.assumeRoleWithWebIdentity).not.toHaveBeenCalled()
    expect(drive.writeJsonFile).toHaveBeenCalledWith(
      'tok', 'folder-1', S3_SYNC_STATUS_FILE_NAME,
      expect.objectContaining({ lastSyncError: expect.stringContaining('sign out') }),
      undefined,
    )
  })
})

describe('resyncSingleEntry', () => {
  it('mirrors the entry and clears it from a finished backfill\'s failed list', async () => {
    const record = makeRecord({}, {
      backfillProgress: { total: 5, done: 5, failed: ['2026-01-01'], finishedAt: '2026-01-01T00:00:00.000Z' },
    })

    const result = await resyncSingleEntry('tok', 'sid', makeSession(), {} as any, record, '2026-01-01')

    expect(result).toEqual({ ok: true })
    expect(s3.putObjectIfNewer).toHaveBeenCalledWith(
      { accessKeyId: 'ak', secretAccessKey: 'sk', sessionToken: 'st', expiresAt: MOCK_CREDS_EXPIRES_AT },
      'my-bucket', 'us-east-1', 'diary-2026-01-01.txt', 'hello', '5', undefined, { fileId: 'file-1' },
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
    const record = makeRecord({}, { backfillProgress: activeProgress })

    const result = await resyncSingleEntry('tok', 'sid', makeSession(), {} as any, record, '2026-01-01')

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
    const record = makeRecord()

    await resyncSingleEntry('tok', 'sid', makeSession(), {} as any, record, '2026-01-01')

    expect(drive.writeJsonFile).not.toHaveBeenCalled()
  })

  it('treats an entry no longer in Drive as nothing to back up, not a failure', async () => {
    vi.mocked(drive.findCurrentEntryMeta).mockResolvedValue(null)
    const record = makeRecord({}, {
      backfillProgress: { total: 1, done: 1, failed: ['2026-01-01'], finishedAt: '2026-01-01T00:00:00.000Z' },
    })

    const result = await resyncSingleEntry('tok', 'sid', makeSession(), {} as any, record, '2026-01-01')

    expect(result).toEqual({ ok: true })
    expect(s3.putObjectIfNewer).not.toHaveBeenCalled()
  })

  it('records a failure and returns ok:false when the mirror fails, without touching an active backfillProgress', async () => {
    vi.mocked(s3.putObjectIfNewer).mockRejectedValue(new s3.S3Error(403, 'AccessDenied'))
    const activeProgress = { total: 5, done: 2, failed: ['2026-01-01'], remaining: ['x', 'y'] }
    const record = makeRecord({}, { backfillProgress: activeProgress })

    const result = await resyncSingleEntry('tok', 'sid', makeSession(), {} as any, record, '2026-01-01')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('AccessDenied')
    const [, , , written] = vi.mocked(drive.writeJsonFile).mock.calls.at(-1)!
    expect((written as any).backfillProgress).toEqual(activeProgress)
    expect((written as any).lastSyncError).toContain('AccessDenied')
  })
})

describe('reconciliation against current Drive state', () => {
  const creds = { accessKeyId: 'ak', secretAccessKey: 'sk', sessionToken: 'st', expiresAt: MOCK_CREDS_EXPIRES_AT }
  const run = () => reconcileS3Entry('tok', 'sid', makeSession(), {} as any, baseSettings, creds, '2026-01-01')

  it('mirrors a recreated file using its identity even when its version is lower', async () => {
    vi.mocked(drive.findCurrentEntryMeta).mockResolvedValue({ id: 'new-file', name: 'diary-2026-01-01.txt', version: '1' })
    await run()
    expect(s3.putObjectIfNewer).toHaveBeenCalledWith(creds, 'my-bucket', 'us-east-1', 'diary-2026-01-01.txt', 'hello', '1', undefined, { fileId: 'new-file' })
    expect(s3.deleteObject).not.toHaveBeenCalled()
  })
  it('repairs an entry recreated while its old backup is being deleted', async () => {
    vi.mocked(drive.findCurrentEntryMeta).mockResolvedValueOnce(null).mockResolvedValue({ id: 'recreated', name: 'diary-2026-01-01.txt', version: '1' })
    await run()
    expect(s3.deleteObject).toHaveBeenCalledOnce()
    expect(s3.putObjectIfNewer).toHaveBeenCalledWith(creds, 'my-bucket', 'us-east-1', 'diary-2026-01-01.txt', 'hello', '1', undefined, { fileId: 'recreated' })
  })
  it('removes an entry deleted during upload', async () => {
    vi.mocked(drive.findCurrentEntryMeta).mockResolvedValueOnce({ id: 'old', name: 'diary-2026-01-01.txt', version: '5' }).mockResolvedValue(null)
    await run()
    expect(s3.putObjectIfNewer).toHaveBeenCalledOnce()
    expect(s3.deleteObject).toHaveBeenCalledOnce()
  })
  it('does not authorize deletion when Drive cannot confirm absence', async () => {
    vi.mocked(drive.findCurrentEntryMeta).mockRejectedValueOnce(new DriveError(503, 'unavailable'))
    await expect(run()).rejects.toThrow()
    expect(s3.deleteObject).not.toHaveBeenCalled()
  })
  it('retries with fresh content if Drive changes during upload', async () => {
    const old = { id: 'file', name: 'diary-2026-01-01.txt', version: '1' }
    const updated = { ...old, version: '2' }
    vi.mocked(drive.findCurrentEntryMeta).mockResolvedValueOnce(old).mockResolvedValue(updated)
    vi.mocked(drive.getEntryContent).mockResolvedValueOnce({ date: '', content: 'old' }).mockResolvedValue({ date: '', content: 'new' })
    await run()
    expect(s3.putObjectIfNewer).toHaveBeenLastCalledWith(creds, 'my-bucket', 'us-east-1', 'diary-2026-01-01.txt', 'new', '2', undefined, { fileId: 'file' })
  })
})

describe('withFreshS3Status re-reads fresh before merging', () => {
  // writeBackfillProgress/finishBackfill/recordMirrorFailure/recordMirrorSuccess run
  // concurrently with other status writers (another device's mirror, a different
  // chunk of the same backfill), which can change the status file's content while a
  // caller is still holding an older in-memory snapshot. Blindly spreading that stale
  // snapshot as the write's base would silently lose the other writer's update. These
  // writers re-read the status file immediately before writing and merge only their
  // own field(s) onto that fresh read instead.
  it('writeBackfillProgress merges onto a freshly re-read file, not the stale in-memory snapshot', async () => {
    const staleRecord = makeRecord({}, { lastSyncError: 'stale in-memory error' })
    // Another writer already cleared the error while this chunk was in flight.
    vi.mocked(drive.readJsonFile).mockResolvedValue({})

    await writeBackfillProgress('tok', staleRecord, { total: 5, done: 3, failed: [], remaining: ['x'] })

    const [, , , written] = vi.mocked(drive.writeJsonFile).mock.calls.at(-1)!
    expect((written as any).lastSyncError).toBeUndefined()
    expect((written as any).backfillProgress).toEqual({ total: 5, done: 3, failed: [], remaining: ['x'], updatedAt: expect.any(String) })
  })

  it('finishBackfill merges onto a freshly re-read file, not the stale in-memory snapshot', async () => {
    const staleRecord = makeRecord({}, { lastSyncErrorDate: 'old-date-should-be-overwritten' })
    // Another writer recorded a different dated error while this chunk was in flight.
    vi.mocked(drive.readJsonFile).mockResolvedValue({ lastSyncErrorDate: '2026-03-03' })

    await finishBackfill('tok', staleRecord, 5, [], 'Resync')

    const [, , , written] = vi.mocked(drive.writeJsonFile).mock.calls.at(-1)!
    // finishBackfill always drops lastSyncErrorDate regardless of what it re-read
    // (a run-level summary error isn't scoped to any one date) — the fresh re-read is
    // what it's dropping it *from*.
    expect((written as any).lastSyncErrorDate).toBeUndefined()
  })

  it('does not overwrite progress with a stale snapshot when its fresh read fails', async () => {
    const record = makeRecord({}, { lastSyncError: 'old' })
    vi.mocked(drive.readJsonFile).mockRejectedValue(new Error('Drive is down'))
    await expect(writeBackfillProgress('tok', record, { total: 1, done: 1, failed: [], remaining: [] })).rejects.toThrow('Drive is down')
    expect(drive.writeJsonFile).not.toHaveBeenCalled()
  })
  it('mirrorEntrySave failure recording also merges onto a freshly re-read status file', async () => {
    // First status read (loadS3SettingsRecord, at the start of mirrorEntrySave) sees no
    // error; a second, later read (the fresh re-read inside recordMirrorFailure) sees
    // what another writer just recorded concurrently.
    vi.mocked(drive.findJsonFile).mockImplementation(async (_t, _f, fileName) =>
      fileName === S3_SETTINGS_FILE_NAME ? CONFIG_FILE_ID : STATUS_FILE_ID)
    vi.mocked(drive.readJsonFile).mockImplementation((() => {
      let statusReads = 0
      return async (_t: string, fileId: string) => {
        if (fileId === CONFIG_FILE_ID) return baseSettings
        statusReads += 1
        return statusReads === 1 ? {} : { lastSyncErrorDate: '2026-02-02', lastSyncError: 'other date failure' }
      }
    })())
    vi.mocked(s3.putObjectIfNewer).mockRejectedValue(new s3.S3Error(403, 'AccessDenied'))
    const sess = makeSession()

    await resyncSingleEntry('tok', 'sid', sess, {} as any, (await loadS3SettingsRecord('tok', 'sid', sess, {} as any))!, '2026-01-01')

    const [, , , written] = vi.mocked(drive.writeJsonFile).mock.calls.at(-1)!
    // This write's own date (2026-01-01) wins for lastSyncErrorDate/lastSyncError, but
    // it was merged onto the freshly re-read object, not the stale empty snapshot.
    expect((written as any).lastSyncErrorDate).toBe('2026-01-01')
    expect((written as any).lastSyncError).toEqual(expect.stringContaining('AccessDenied'))
  })
})

describe('checkpoint durability', () => {
  it('keeps the last checkpoint if persisting a new one fails', async () => {
    const record = makeRecord({}, { backfillProgress: { total: 2, done: 0, failed: [], remaining: ['a', 'b'] } })
    vi.mocked(drive.writeJsonFile).mockRejectedValueOnce(new Error('write failed'))
    await expect(writeBackfillProgress('tok', record, { total: 2, done: 1, failed: [], remaining: ['b'] })).rejects.toThrow('write failed')
    expect(record.status.backfillProgress?.remaining).toEqual(['a', 'b'])
  })
  it('creates a missing progress file and remembers its id', async () => {
    const record = makeRecord({}, {}, { statusFileId: null })
    await writeBackfillProgress('tok', record, { total: 1, done: 0, failed: [], remaining: ['a'] })
    expect(record.statusFileId).toBe(STATUS_FILE_ID)
    expect(drive.readJsonFile).not.toHaveBeenCalled()
  })
})

describe('isBackfillRunActive', () => {
  it('is false when there is no progress at all', () => {
    expect(isBackfillRunActive(undefined)).toBe(false)
  })

  it('is false once finishedAt is set, regardless of updatedAt', () => {
    expect(isBackfillRunActive({
      total: 5, done: 5, failed: [], finishedAt: '2026-01-01T00:00:00.000Z', updatedAt: new Date().toISOString(),
    })).toBe(false)
  })

  it('is false when updatedAt was never stamped (a record from before this field existed)', () => {
    expect(isBackfillRunActive({ total: 5, done: 2, failed: [], remaining: ['x'] })).toBe(false)
  })

  it('is true for a run with a recent update and no finishedAt', () => {
    expect(isBackfillRunActive({
      total: 5, done: 2, failed: [], remaining: ['x'], updatedAt: new Date().toISOString(),
    })).toBe(true)
  })

  it('is false for a run whose last update is older than the staleness window — an orphaned run', () => {
    const elevenMinutesAgo = new Date(Date.now() - 11 * 60 * 1000).toISOString()
    expect(isBackfillRunActive({
      total: 5, done: 2, failed: [], remaining: ['x'], updatedAt: elevenMinutesAgo,
    })).toBe(false)
  })
})

describe('backfillAllEntries', () => {
  beforeEach(() => {
    vi.mocked(drive.findCurrentEntryMeta).mockImplementation(async (...args) => {
      const files = await drive.listEntries(args[0], args[1], args[2], args[3])
      return files.find(file => file.name === `diary-${args[4]}.txt`) ?? null
    })
  })

  it('retains unprocessed dates in the persisted checkpoint while a chunk is interrupted', async () => {
    const dates = ['2026-01-01', '2026-01-02', '2026-01-03']
    vi.mocked(drive.listEntries).mockResolvedValue(dates.map((date, i) => ({ id: `f${i}`, name: `diary-${date}.txt`, version: '1' })))
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const blocked = new Promise<void>(resolve => { entered = resolve })
    let now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now += 3000)
    vi.mocked(drive.getEntryContent).mockImplementation(async (_token, id) => {
      if (id === 'f1') { entered(); await gate }
      return { date: '', content: 'text' }
    })
    const run = backfillAllEntries('tok', 'sid', makeSession(), {} as any, makeRecord(), undefined, 'Backfill', 2)
    try {
      await blocked
      expect(persistedStatus.backfillProgress).toMatchObject({ done: 1, remaining: [dates[1], dates[2]] })
    } finally {
      release()
      await run
      clock.mockRestore()
    }
  })

  it('mirrors every existing entry once, reusing a single set of assumed credentials', async () => {
    vi.mocked(drive.listEntries).mockResolvedValue([
      { id: 'f1', name: 'diary-2026-01-01.txt', version: '1' },
      { id: 'f2', name: 'diary-2026-01-02.txt', version: '2' },
    ] as any)
    vi.mocked(drive.getEntryContent).mockImplementation(async (_tok, fileId) =>
      ({ date: '', content: fileId === 'f1' ? 'day one' : 'day two' }))
    const sess = makeSession()

    await backfillAllEntries('tok', 'sid', sess, {} as any, makeRecord())

    expect(s3.assumeRoleWithWebIdentity).toHaveBeenCalledOnce()
    expect(s3.putObjectIfNewer).toHaveBeenCalledWith(expect.anything(), 'my-bucket', 'us-east-1', 'diary-2026-01-01.txt', 'day one', '1', undefined, { fileId: 'f1' })
    expect(s3.putObjectIfNewer).toHaveBeenCalledWith(expect.anything(), 'my-bucket', 'us-east-1', 'diary-2026-01-02.txt', 'day two', '2', undefined, { fileId: 'f2' })
  })

  it('skips files that are not diary entries', async () => {
    vi.mocked(drive.listEntries).mockResolvedValue([
      { id: 'f1', name: 's3_settings.json', version: '1' },
    ] as any)
    const sess = makeSession()

    await backfillAllEntries('tok', 'sid', sess, {} as any, makeRecord())

    expect(drive.getEntryContent).not.toHaveBeenCalled()
    expect(s3.putObjectIfNewer).not.toHaveBeenCalled()
  })

  it('records a descriptive failure and does not throw when the backfill fails partway through', async () => {
    vi.mocked(drive.listEntries).mockRejectedValue(new Error('Drive is down'))
    const sess = makeSession()

    await expect(backfillAllEntries('tok', 'sid', sess, {} as any, makeRecord())).resolves.toBeUndefined()

    expect(drive.writeJsonFile).toHaveBeenCalledWith(
      'tok', 'folder-1', S3_SYNC_STATUS_FILE_NAME,
      expect.objectContaining({ lastSyncError: expect.stringContaining('Error occurred') }),
      STATUS_FILE_ID,
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

    await backfillAllEntries('tok', 'sid', sess, {} as any, makeRecord())

    // Both entries were attempted despite the first one failing.
    expect(s3.putObjectIfNewer).toHaveBeenCalledWith(expect.anything(), 'my-bucket', 'us-east-1', 'diary-2026-01-02.txt', 'day two', '2', undefined, { fileId: 'f2' })
    expect(drive.writeJsonFile).toHaveBeenLastCalledWith(
      'tok', 'folder-1', S3_SYNC_STATUS_FILE_NAME,
      expect.objectContaining({
        backfillProgress: expect.objectContaining({ total: 2, done: 2, failed: ['2026-01-01'] }),
        lastSyncError: expect.stringContaining('1 of 2'),
      }),
      STATUS_FILE_ID,
    )
  })

  it('only processes dates in onlyDates when given (a retry of previously-failed entries)', async () => {
    vi.mocked(drive.listEntries).mockResolvedValue([
      { id: 'f1', name: 'diary-2026-01-01.txt', version: '1' },
      { id: 'f2', name: 'diary-2026-01-02.txt', version: '2' },
    ] as any)
    vi.mocked(drive.getEntryContent).mockResolvedValue({ date: '', content: 'day one' })
    const sess = makeSession()

    await backfillAllEntries('tok', 'sid', sess, {} as any, makeRecord(), ['2026-01-01'])

    expect(drive.getEntryContent).toHaveBeenCalledOnce()
    expect(s3.putObjectIfNewer).toHaveBeenCalledWith(expect.anything(), 'my-bucket', 'us-east-1', 'diary-2026-01-01.txt', 'day one', '1', undefined, { fileId: 'f1' })
    expect(s3.putObjectIfNewer).not.toHaveBeenCalledWith(expect.anything(), 'my-bucket', 'us-east-1', 'diary-2026-01-02.txt', expect.anything(), expect.anything())
  })

  it('uses the given runLabel in the recorded failure message instead of "Initial backfill"', async () => {
    vi.mocked(drive.listEntries).mockRejectedValue(new Error('Drive is down'))
    const sess = makeSession()

    await backfillAllEntries('tok', 'sid', sess, {} as any, makeRecord(), undefined, 'Resync')

    expect(drive.writeJsonFile).toHaveBeenCalledWith(
      'tok', 'folder-1', S3_SYNC_STATUS_FILE_NAME,
      expect.objectContaining({ lastSyncError: expect.stringMatching(/^Resync failed:/) }),
      STATUS_FILE_ID,
    )
  })

  it('clears backfillProgress and lastSyncError once every entry succeeds', async () => {
    vi.mocked(drive.listEntries).mockResolvedValue([
      { id: 'f1', name: 'diary-2026-01-01.txt', version: '1' },
    ] as any)
    vi.mocked(drive.getEntryContent).mockResolvedValue({ date: '', content: 'day one' })
    const sess = makeSession()

    await backfillAllEntries('tok', 'sid', sess, {} as any, makeRecord({}, {
      backfillProgress: { total: 1, done: 1, failed: ['2026-01-01'], finishedAt: '2026-01-01T00:00:00.000Z' },
      lastSyncError: 'Initial backfill: 1 of 1 entry failed to back up',
      lastSyncErrorAt: '2026-01-01T00:00:00.000Z',
    }))

    const [, , , updated] = vi.mocked(drive.writeJsonFile).mock.calls.at(-1)!
    expect(updated).not.toHaveProperty('backfillProgress')
    expect(updated).not.toHaveProperty('lastSyncError')
    expect(updated).not.toHaveProperty('lastSyncErrorAt')
    expect(updated).not.toHaveProperty('lastSyncErrorDate')
  })

  it('does not leave a stale single-date lastSyncErrorDate behind when finishing with failures across multiple dates', async () => {
    // finishBackfill's own error is an account-wide summary of potentially many
    // failed dates, not any one of them — a lastSyncErrorDate left over from an
    // earlier single-entry failure must not survive and get misattributed.
    vi.mocked(drive.listEntries).mockRejectedValue(new Error('Drive is down'))
    const sess = makeSession()

    await backfillAllEntries('tok', 'sid', sess, {} as any, makeRecord({}, {
      lastSyncError: 'old single-entry failure',
      lastSyncErrorAt: '2026-01-01T00:00:00.000Z',
      lastSyncErrorDate: '2026-01-01',
    }))

    const [, , , updated] = vi.mocked(drive.writeJsonFile).mock.calls.at(-1)!
    expect(updated).not.toHaveProperty('lastSyncErrorDate')
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
    await backfillAllEntries('tok', 'sid', sess, {} as any, makeRecord({}, { backfillProgress: staleProgress }), undefined, 'Resync')

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
    await backfillAllEntries('tok', 'sid', sess, {} as any, makeRecord({}, { backfillProgress: { total: 5, done: 3, failed: [] } }), undefined, 'Resync')

    const progressWrite = vi.mocked(drive.writeJsonFile).mock.calls.slice().reverse().find(
      ([, , name, body]) => name === S3_SYNC_STATUS_FILE_NAME && (body as any).backfillProgress,
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
    await backfillAllEntries(
      'tok', 'sid', sess, {} as any,
      makeRecord({}, { backfillProgress: { total: 3, done: 2, failed: ['2026-01-03'] } }),
      ['2026-01-03'],
    )

    // Only one entry processed (the failed one)
    expect(s3.putObjectIfNewer).toHaveBeenCalledTimes(1)
    expect(s3.putObjectIfNewer).toHaveBeenCalledWith(expect.anything(), 'my-bucket', 'us-east-1', 'diary-2026-01-03.txt', 'day', '3', undefined, { fileId: 'f3' })

    // Progress should carry over: done=3 (baseDone=2 + 1 processed)
    const progressWrite = vi.mocked(drive.writeJsonFile).mock.calls.slice().reverse().find(
      ([, , name, body]) => name === S3_SYNC_STATUS_FILE_NAME && (body as any).backfillProgress,
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

    await backfillAllEntries('tok', 'sid', sess, {} as any, makeRecord(), undefined, 'Initial backfill', 2)

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
      makeRecord({}, { backfillProgress: { total: 3, done: 1, failed: [], remaining: ['2026-01-02', '2026-01-03'] } }),
      ['2026-01-02', '2026-01-03'], 'Backfill', 20,
    )

    // 2026-01-03 must still be mirrored despite 02's disappearance shifting Drive's listing.
    expect(s3.putObjectIfNewer).toHaveBeenCalledWith(expect.anything(), 'my-bucket', 'us-east-1', 'diary-2026-01-03.txt', 'day', '3', undefined, { fileId: 'f3' })
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
    await backfillAllEntries('tok', 'sid', sess, {} as any, makeRecord({}, {
      backfillProgress: { total: 3, done: 3, failed: ['2026-01-01'], finishedAt: '2026-01-01T00:00:00.000Z' },
    }), undefined, 'Resync')

    // The single entry is processed and succeeds
    expect(s3.putObjectIfNewer).toHaveBeenCalledOnce()

    // failed list should be cleared (entry succeeded this time), not carried over
    const lastWrite = vi.mocked(drive.writeJsonFile).mock.calls.at(-1)!
    const updated = lastWrite[3] as any
    expect(updated).not.toHaveProperty('backfillProgress')
  })
})
