import { beforeEach, describe, expect, it, vi } from 'vitest'
import { onRequestGet as entryStatusGet } from '../../functions/api/s3/entry-status/[date]'
import { onRequestPost as entryResyncPost } from '../../functions/api/s3/entry-resync/[date]'
import { onRequestPost as resyncPost } from '../../functions/api/s3/resync'
import { onRequestPost as backfillRetryPost } from '../../functions/api/s3/backfill-retry'
import { onRequestGet as settingsGet, onRequestPut as settingsPut } from '../../functions/api/s3/settings'
import * as drive from '../../functions/_shared/drive'
import * as s3Settings from '../../functions/_shared/s3Settings'

// These endpoints all delegate to the Workflow Worker (via the S3_WORKFLOW_SERVICE
// service binding) instead of the legacy Drive/S3-direct path whenever the binding
// is present and the session carries a google_sub — see each handler's own
// "S3_WORKFLOW_SERVICE" branch. The pre-existing handler tests only ever exercise
// the legacy fallback (their makeContext() env is always `{}`), so this file covers
// the now-primary Workflow-backed branch instead.

vi.mock('../../functions/_shared/drive', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../functions/_shared/drive')>()),
  ensureFolder: vi.fn().mockResolvedValue('folder-1'),
  findJsonFile: vi.fn().mockResolvedValue(null),
  readJsonFile: vi.fn(),
  writeJsonFile: vi.fn().mockResolvedValue({ id: 'settings-file', name: 's3_settings.json', version: '1' }),
}))

vi.mock('../../functions/_shared/s3Settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../functions/_shared/s3Settings')>()),
  getS3Settings: vi.fn(),
}))

vi.mock('../../functions/_shared/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../functions/_shared/session')>()),
  saveSession: vi.fn().mockResolvedValue(undefined),
}))

function makeService(overrides: Record<string, unknown> = {}) {
  return {
    startBackfill: vi.fn(),
    resetAllData: vi.fn().mockResolvedValue(undefined),
    getJob: vi.fn(),
    getEntryStatus: vi.fn(),
    setBackupEnabled: vi.fn().mockResolvedValue(undefined),
    mirrorEntry: vi.fn(),
    mirrorEntryNow: vi.fn(),
    deleteEntry: vi.fn(),
    getWorkflowUsage: vi.fn(),
    ...overrides,
  }
}

// A fresh object per call, not a shared constant — several of these handlers cache
// Drive file ids onto the session object as a side effect (e.g. loadS3SettingsRecord
// stamping s3_settings_file_id), and reusing one mutable object across tests would
// leak that caching between otherwise-unrelated tests.
function makeSession() {
  return { google_sub: '1234567890' }
}
const validSettings = { enabled: true, roleArn: 'arn:aws:iam::123456789012:role/linger-s3', bucket: 'my-bucket', region: 'us-east-1' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(drive.ensureFolder).mockResolvedValue('folder-1')
  vi.mocked(drive.findJsonFile).mockResolvedValue(null)
  vi.mocked(drive.writeJsonFile).mockImplementation(async (_token, _folderId, fileName, _body, existingFileId) => ({
    id: existingFileId ?? (fileName === 's3_settings.json' ? 'settings-file' : 'status-file'),
    name: fileName,
    version: '1',
  }))
})

describe('GET /api/s3/entry-status/[date] — via S3_WORKFLOW_SERVICE', () => {
  function makeContext(overrides: Record<string, unknown> = {}) {
    return {
      request: new Request('http://localhost/api/s3/entry-status/2026-05-01?version=5'),
      params: { date: '2026-05-01' },
      data: { accessToken: 'tok', sessionId: 'sid', session: makeSession() },
      env: { S3_WORKFLOW_SERVICE: makeService() },
      ...overrides,
    }
  }

  it('delegates to getEntryStatus and returns its result verbatim', async () => {
    const service = makeService({ getEntryStatus: vi.fn().mockResolvedValue({ status: 'synced' }) })
    const res = await entryStatusGet(makeContext({ env: { S3_WORKFLOW_SERVICE: service } }) as any)
    expect(await res.json()).toEqual({ status: 'synced' })
    expect(service.getEntryStatus).toHaveBeenCalledWith({ sessionId: 'sid', accountKey: '1234567890', date: '2026-05-01', requestedVersion: '5' })
  })

  it('falls back to pending instead of failing the request when the Workflow lookup errors', async () => {
    const service = makeService({ getEntryStatus: vi.fn().mockRejectedValue(new Error('DO unavailable')) })
    const res = await entryStatusGet(makeContext({ env: { S3_WORKFLOW_SERVICE: service } }) as any)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'pending' })
  })

  it('never calls the Workflow service for a session without google_sub (legacy fallback stays reachable)', async () => {
    const service = makeService({ getEntryStatus: vi.fn().mockResolvedValue({ status: 'synced' }) })
    vi.mocked(s3Settings.getS3Settings).mockResolvedValue(null)
    await entryStatusGet(makeContext({ data: { accessToken: 'tok', sessionId: 'sid', session: {} }, env: { S3_WORKFLOW_SERVICE: service } }) as any)
    expect(service.getEntryStatus).not.toHaveBeenCalled()
  })
})

describe('POST /api/s3/entry-resync/[date] — via S3_WORKFLOW_SERVICE', () => {
  function makeContext(overrides: Record<string, unknown> = {}) {
    return {
      request: new Request('http://localhost/api/s3/entry-resync/2026-05-01', { method: 'POST' }),
      params: { date: '2026-05-01' },
      data: { accessToken: 'tok', sessionId: 'sid', session: makeSession() },
      env: { S3_WORKFLOW_SERVICE: makeService() },
      ...overrides,
    }
  }

  it('returns ok on a successful mirror', async () => {
    const service = makeService({ mirrorEntryNow: vi.fn().mockResolvedValue({ ok: true }) })
    const res = await entryResyncPost(makeContext({ env: { S3_WORKFLOW_SERVICE: service } }) as any)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(service.mirrorEntryNow).toHaveBeenCalledWith({ sessionId: 'sid', accountKey: '1234567890', date: '2026-05-01' })
  })

  it('surfaces a failed mirror as a 502 with its error message', async () => {
    const service = makeService({ mirrorEntryNow: vi.fn().mockResolvedValue({ ok: false, error: 'S3 write failed' }) })
    const res = await entryResyncPost(makeContext({ env: { S3_WORKFLOW_SERVICE: service } }) as any)
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'S3 write failed' })
  })
})

describe('POST /api/s3/resync — via S3_WORKFLOW_SERVICE', () => {
  function makeContext(overrides: Record<string, unknown> = {}) {
    return {
      request: new Request('http://localhost/api/s3/resync', { method: 'POST' }),
      data: { accessToken: 'tok', sessionId: 'sid', session: makeSession() },
      env: { S3_WORKFLOW_SERVICE: makeService() },
      waitUntil: vi.fn(),
      ...overrides,
    }
  }

  it('starts a backfill and returns 202 with the jobId', async () => {
    const service = makeService({ startBackfill: vi.fn().mockResolvedValue({ created: true, job: { jobId: 'job-1' } }) })
    const res = await resyncPost(makeContext({ env: { S3_WORKFLOW_SERVICE: service } }) as any)
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ ok: true, jobId: 'job-1' })
  })

  it('maps an "already running" rejection to 409', async () => {
    const service = makeService({ startBackfill: vi.fn().mockRejectedValue(new Error('A backfill is already running')) })
    const res = await resyncPost(makeContext({ env: { S3_WORKFLOW_SERVICE: service } }) as any)
    expect(res.status).toBe(409)
  })

  it('maps any other startBackfill failure to 502', async () => {
    const service = makeService({ startBackfill: vi.fn().mockRejectedValue(new Error('boom')) })
    const res = await resyncPost(makeContext({ env: { S3_WORKFLOW_SERVICE: service } }) as any)
    expect(res.status).toBe(502)
  })
})

describe('POST /api/s3/backfill-retry — via S3_WORKFLOW_SERVICE', () => {
  function makeContext(overrides: Record<string, unknown> = {}) {
    return {
      request: new Request('http://localhost/api/s3/backfill-retry', { method: 'POST' }),
      data: { accessToken: 'tok', sessionId: 'sid', session: makeSession() },
      env: { S3_WORKFLOW_SERVICE: makeService() },
      waitUntil: vi.fn(),
      ...overrides,
    }
  }

  it("retries exactly the previous job's failed dates", async () => {
    const service = makeService({
      getJob: vi.fn().mockResolvedValue({ failedDates: ['2026-01-01', '2026-01-02'] }),
      startBackfill: vi.fn().mockResolvedValue({ created: true, job: { jobId: 'job-2' } }),
    })
    const res = await backfillRetryPost(makeContext({ env: { S3_WORKFLOW_SERVICE: service } }) as any)
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ ok: true, jobId: 'job-2', retrying: 2 })
    expect(service.startBackfill).toHaveBeenCalledWith(expect.objectContaining({ scope: ['2026-01-01', '2026-01-02'] }))
  })

  it('returns 400 when there is nothing to retry, without starting a Workflow', async () => {
    const service = makeService({ getJob: vi.fn().mockResolvedValue(null) })
    const res = await backfillRetryPost(makeContext({ env: { S3_WORKFLOW_SERVICE: service } }) as any)
    expect(res.status).toBe(400)
    expect(service.startBackfill).not.toHaveBeenCalled()
  })

  it('maps an "already running" rejection to 409', async () => {
    const service = makeService({
      getJob: vi.fn().mockResolvedValue({ failedDates: ['2026-01-01'] }),
      startBackfill: vi.fn().mockRejectedValue(new Error('A backfill is already running')),
    })
    const res = await backfillRetryPost(makeContext({ env: { S3_WORKFLOW_SERVICE: service } }) as any)
    expect(res.status).toBe(409)
  })
})

describe('GET /api/s3/settings — via S3_WORKFLOW_SERVICE', () => {
  function makeContext(overrides: Record<string, unknown> = {}) {
    return {
      request: new Request('http://localhost/api/s3/settings'),
      data: { accessToken: 'tok', sessionId: 'sid', session: makeSession() },
      env: { S3_WORKFLOW_SERVICE: makeService() },
      ...overrides,
    }
  }

  it('merges the current job into the settings response as backfillProgress', async () => {
    vi.mocked(s3Settings.getS3Settings).mockResolvedValue(validSettings as never)
    const service = makeService({
      getJob: vi.fn().mockResolvedValue({ total: 10, completed: 4, failedDates: ['2026-01-01'], startedAt: '2026-01-01T00:00:00.000Z' }),
    })
    const res = await settingsGet(makeContext({ env: { S3_WORKFLOW_SERVICE: service } }) as any)
    const body = await res.json() as any
    expect(body.backfillProgress).toEqual({
      total: 10,
      done: 4,
      failed: ['2026-01-01'],
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
  })

  it('surfaces a finished job with an error as lastSyncError', async () => {
    vi.mocked(s3Settings.getS3Settings).mockResolvedValue(validSettings as never)
    const service = makeService({
      getJob: vi.fn().mockResolvedValue({
        total: 10, completed: 9, failedDates: ['2026-01-01'],
        startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:05:00.000Z', error: 'Backfill target limit exceeded',
      }),
    })
    const res = await settingsGet(makeContext({ env: { S3_WORKFLOW_SERVICE: service } }) as any)
    const body = await res.json() as any
    expect(body.lastSyncError).toBe('Backfill target limit exceeded')
    expect(body.lastSyncErrorAt).toBe('2026-01-01T00:05:00.000Z')
  })

  it('returns settings unchanged when there is no settings file yet', async () => {
    vi.mocked(s3Settings.getS3Settings).mockResolvedValue(null)
    const service = makeService()
    const res = await settingsGet(makeContext({ env: { S3_WORKFLOW_SERVICE: service } }) as any)
    expect(await res.json()).toBeNull()
    expect(service.getJob).not.toHaveBeenCalled()
  })
})

describe('PUT /api/s3/settings — via S3_WORKFLOW_SERVICE', () => {
  function makeContext(overrides: Record<string, unknown> = {}) {
    return {
      request: new Request('http://localhost/api/s3/settings', { method: 'PUT', body: JSON.stringify(validSettings) }),
      data: { accessToken: 'tok', sessionId: 'sid', session: makeSession() },
      env: { S3_WORKFLOW_SERVICE: makeService() },
      waitUntil: vi.fn(),
      ...overrides,
    }
  }

  it('starts a Workflow backfill on first enable and returns 202 with the jobId', async () => {
    const service = makeService({ startBackfill: vi.fn().mockResolvedValue({ created: true, job: { jobId: 'job-3' } }) })
    const ctx = makeContext({ env: { S3_WORKFLOW_SERVICE: service } })
    const res = await settingsPut(ctx as any)
    expect(res.status).toBe(202)
    expect(((await res.json()) as any).jobId).toBe('job-3')
    expect(service.setBackupEnabled).toHaveBeenCalledWith({ sessionId: 'sid', accountKey: '1234567890', enabled: true, resetEntries: true })
    // The legacy in-request backfillAllEntries path must never also fire once the
    // Workflow Worker is handling this account — that would double-mirror every entry.
    expect(ctx.waitUntil).not.toHaveBeenCalled()
  })

  it('only updates backup-enabled state (no new job) when re-saving with backup already enabled', async () => {
    vi.mocked(drive.findJsonFile).mockResolvedValue('settings-file')
    vi.mocked(drive.readJsonFile).mockResolvedValue(validSettings)
    const service = makeService()
    const ctx = makeContext({ env: { S3_WORKFLOW_SERVICE: service } })
    const res = await settingsPut(ctx as any)
    expect(res.status).toBe(200)
    expect(service.startBackfill).not.toHaveBeenCalled()
    // Not a first-time enable, so this must NOT reset entries — resetEntries: true
    // here would wipe sync history (and, per resetAllData's own guard, refuse to
    // run at all) on every plain re-save of already-enabled settings.
    expect(service.setBackupEnabled).toHaveBeenCalledWith({ sessionId: 'sid', accountKey: '1234567890', enabled: true })
  })

  it('maps an "already running" rejection from startBackfill to 409', async () => {
    const service = makeService({ startBackfill: vi.fn().mockRejectedValue(new Error('A backfill is already running')) })
    const res = await settingsPut(makeContext({ env: { S3_WORKFLOW_SERVICE: service } }) as any)
    expect(res.status).toBe(409)
  })

  it('maps any other startBackfill failure to 502 without losing the already-saved settings', async () => {
    const service = makeService({ startBackfill: vi.fn().mockRejectedValue(new Error('boom')) })
    const res = await settingsPut(makeContext({ env: { S3_WORKFLOW_SERVICE: service } }) as any)
    expect(res.status).toBe(502)
    expect(drive.writeJsonFile).toHaveBeenCalled()
  })
})
