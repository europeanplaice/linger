import { beforeEach, describe, expect, it, vi } from 'vitest'
import { onRequestGet, onRequestPut } from '../../functions/api/s3/settings'
import * as drive from '../../functions/_shared/drive'
import * as s3Settings from '../../functions/_shared/s3Settings'
import * as session from '../../functions/_shared/session'

vi.mock('../../functions/_shared/drive', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../functions/_shared/drive')>()),
  ensureFolder: vi.fn().mockResolvedValue('folder-1'),
  findJsonFile: vi.fn().mockResolvedValue(null),
  readJsonFile: vi.fn(),
  writeJsonFile: vi.fn().mockResolvedValue({ id: 'settings-file', name: 's3_settings.json', version: '1' }),
}))

vi.mock('../../functions/_shared/s3Settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../functions/_shared/s3Settings')>()),
  backfillAllEntries: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../functions/_shared/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../functions/_shared/session')>()),
  saveSession: vi.fn().mockResolvedValue(undefined),
}))

const validSettings = { enabled: true, roleArn: 'arn:aws:iam::123456789012:role/linger-s3', bucket: 'my-bucket', region: 'us-east-1' }

function makeContext(overrides: Record<string, unknown> = {}) {
  return {
    request: new Request('http://localhost/'),
    data: { accessToken: 'tok', sessionId: 'sid', session: {} },
    env: {},
    waitUntil: vi.fn(),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(drive.ensureFolder).mockResolvedValue('folder-1')
  vi.mocked(drive.findJsonFile).mockResolvedValue(null)
  // Config and status are separate Drive files now (see s3Settings.ts) — resolve each
  // write to the id matching whichever file it's writing, defaulting to a fresh id
  // when there's no existing one to reuse (mirrors what a real Drive create returns).
  vi.mocked(drive.writeJsonFile).mockImplementation(async (_token, _folderId, fileName, _body, existingFileId) => ({
    id: existingFileId ?? (fileName === 's3_settings.json' ? 'settings-file' : 'status-file'),
    name: fileName,
    version: '1',
  }))
})

describe('GET /api/s3/settings', () => {
  it('returns null when no settings file exists', async () => {
    const res = await onRequestGet(makeContext() as any)
    expect(res.status).toBe(200)
    expect(await res.json()).toBeNull()
  })
})

describe('PUT /api/s3/settings', () => {
  it('rejects malformed settings', async () => {
    const ctx = makeContext({
      request: new Request('http://localhost/api/s3/settings', { method: 'PUT', body: JSON.stringify({ enabled: true }) }),
    })
    const res = await onRequestPut(ctx as any)
    expect(res.status).toBe(400)
    expect(drive.writeJsonFile).not.toHaveBeenCalled()
  })

  it('triggers a backfill when enabling for the first time (no prior settings file)', async () => {
    const ctx = makeContext({
      request: new Request('http://localhost/api/s3/settings', { method: 'PUT', body: JSON.stringify(validSettings) }),
    })

    const res = await onRequestPut(ctx as any)

    expect(res.status).toBe(200)
    expect(ctx.waitUntil).toHaveBeenCalledOnce()
    // session now carries the freshly-cached settings fileId (see settings.ts's
    // sessionChanged block, kept in sync with what onRequestPut just wrote).
    expect(s3Settings.backfillAllEntries).toHaveBeenCalledWith(
      'tok', 'sid', expect.objectContaining({ s3_settings_file_id: 'settings-file' }), {},
      { config: validSettings, status: {}, folderId: 'folder-1', configFileId: 'settings-file', statusFileId: 'status-file' },
      undefined, 'Initial backfill', 20,
    )
  })

  it('triggers a backfill when transitioning from disabled to enabled', async () => {
    vi.mocked(drive.findJsonFile).mockResolvedValue('settings-file')
    vi.mocked(drive.readJsonFile).mockResolvedValue({ ...validSettings, enabled: false })
    const ctx = makeContext({
      request: new Request('http://localhost/api/s3/settings', { method: 'PUT', body: JSON.stringify(validSettings) }),
    })

    await onRequestPut(ctx as any)

    expect(s3Settings.backfillAllEntries).toHaveBeenCalledOnce()
  })

  it('does not start a second freshStart backfill when re-enabling while one is still unfinished', async () => {
    // Regression guard: disabling mid-backfill strands backfillProgress unfinished
    // (backfill-continue.ts refuses to continue while disabled) — re-enabling shortly
    // after must not race a second freshStart backfillAllEntries against the still-
    // unfinished one (same class of bug guarded against in resync.ts/backfill-retry.ts).
    // Re-enabling alone is enough: backfill-continue.ts resumes driving the existing run.
    vi.mocked(drive.findJsonFile).mockResolvedValue('settings-file')
    vi.mocked(drive.readJsonFile).mockResolvedValue({
      ...validSettings,
      enabled: false,
      backfillProgress: {
        total: 500, done: 120, failed: [], remaining: Array.from({ length: 380 }, (_, i) => `date-${i}`),
        updatedAt: new Date().toISOString(),
      },
    })
    const ctx = makeContext({
      request: new Request('http://localhost/api/s3/settings', { method: 'PUT', body: JSON.stringify(validSettings) }),
    })

    const res = await onRequestPut(ctx as any)

    expect(res.status).toBe(200)
    expect(s3Settings.backfillAllEntries).not.toHaveBeenCalled()
  })

  it('starts a fresh backfill on re-enable when the stranded run is stale (orphaned, no recent progress write)', async () => {
    // isBackfillRunActive treats a run with no update in the last ~10 minutes as
    // abandoned rather than active, so an orphaned run can't permanently block every
    // future re-enable from starting a fresh backfill.
    vi.mocked(drive.findJsonFile).mockResolvedValue('settings-file')
    vi.mocked(drive.readJsonFile).mockResolvedValue({
      ...validSettings,
      enabled: false,
      backfillProgress: {
        total: 500, done: 120, failed: [], remaining: Array.from({ length: 380 }, (_, i) => `date-${i}`),
        updatedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
      },
    })
    const ctx = makeContext({
      request: new Request('http://localhost/api/s3/settings', { method: 'PUT', body: JSON.stringify(validSettings) }),
    })

    const res = await onRequestPut(ctx as any)

    expect(res.status).toBe(200)
    expect(s3Settings.backfillAllEntries).toHaveBeenCalledOnce()
  })

  it('does not trigger a backfill when already enabled and settings are merely edited', async () => {
    vi.mocked(drive.findJsonFile).mockResolvedValue('settings-file')
    vi.mocked(drive.readJsonFile).mockResolvedValue(validSettings)
    const ctx = makeContext({
      request: new Request('http://localhost/api/s3/settings', { method: 'PUT', body: JSON.stringify({ ...validSettings, bucket: 'other-bucket' }) }),
    })

    await onRequestPut(ctx as any)

    expect(s3Settings.backfillAllEntries).not.toHaveBeenCalled()
  })

  it('does not trigger a backfill when disabling', async () => {
    vi.mocked(drive.findJsonFile).mockResolvedValue('settings-file')
    vi.mocked(drive.readJsonFile).mockResolvedValue(validSettings)
    const ctx = makeContext({
      request: new Request('http://localhost/api/s3/settings', { method: 'PUT', body: JSON.stringify({ ...validSettings, enabled: false }) }),
    })

    await onRequestPut(ctx as any)

    expect(s3Settings.backfillAllEntries).not.toHaveBeenCalled()
  })

  it('clears a stale negative settings-cache on the session after a successful write', async () => {
    const sess = { s3_settings_negative_cache_at: Date.now() }
    const ctx = makeContext({
      request: new Request('http://localhost/api/s3/settings', { method: 'PUT', body: JSON.stringify(validSettings) }),
      data: { accessToken: 'tok', sessionId: 'sid', session: sess },
    })

    await onRequestPut(ctx as any)

    expect(sess.s3_settings_negative_cache_at).toBeUndefined()
    expect(session.saveSession).toHaveBeenCalledWith('sid', sess, {})
  })
})
