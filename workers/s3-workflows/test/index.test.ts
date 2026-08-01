import { createExecutionContext, env, runInDurableObject } from 'cloudflare:test'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionData } from '../../../functions/_shared/session'
import * as drive from '../../../functions/_shared/drive'
import { DAILY_WORKFLOW_STEP_BUDGET } from '../src/runtime'
import type { S3SyncIndex } from '../src/syncIndex'
import type { WorkflowEnv } from '../src/types'

vi.mock('../../../functions/_shared/drive', () => ({
  ensureFolder: vi.fn(async () => 'folder-1'),
  findJsonFile: vi.fn(async () => 'settings-file-1'),
  readJsonFile: vi.fn(async () => ({ enabled: true, roleArn: 'arn:aws:iam::123456789012:role/linger', bucket: 'my-bucket', region: 'us-east-1' })),
  findEntryMeta: vi.fn(async () => ({ id: 'file-1', name: 'diary-2026-01-01.txt', version: '1' })),
  getDiaryFileMeta: vi.fn(async (_t: string, _s: string, _sess: unknown, _e: unknown, fileId: string) => ({ id: fileId, name: `diary-${fileId}.txt`, version: '1' })),
  getEntryContent: vi.fn(async () => ({ date: '2026-01-01', content: 'hello' })),
  listEntryPage: vi.fn(async () => ({ files: [], nextPageToken: undefined })),
}))

vi.mock('../../../functions/_shared/s3', () => ({
  assumeRoleWithWebIdentity: vi.fn(async () => ({ accessKeyId: 'AKIA_FAKE', secretAccessKey: 'fake-secret', sessionToken: 'fake-session-token', expiresAt: Date.now() + 3600_000 })),
  putObjectIfNewer: vi.fn(async () => undefined),
  deleteObject: vi.fn(async () => undefined),
  describeError: (e: unknown) => (e instanceof Error ? e.message : 'Unknown error'),
}))

const { default: S3WorkflowsService } = await import('../src/index')

// A startBackfill call kicks off a real (backgrounded, un-awaited) Workflow instance
// that keeps running after the test that started it returns — so every test needs
// its own sessionId, not a shared constant, or a later test overwriting a shared KV
// key out from under a still-running earlier workflow causes spurious cross-test
// "Unauthorized" failures in the background instance.
function sessionIdFor(accountKey: string): string {
  return `session-${accountKey}`
}

async function seedSession(accountKey: string) {
  const session: SessionData = {
    refresh_token: 'refresh',
    access_token: 'access',
    expires_at: Date.now() + 3600_000,
    id_token: 'id-token',
    google_sub: accountKey,
  }
  await env.SESSIONS.put(`session:${sessionIdFor(accountKey)}`, JSON.stringify(session))
}

function service() {
  const workflowEnv = env as unknown as WorkflowEnv
  return new S3WorkflowsService(createExecutionContext(), workflowEnv)
}

describe('S3WorkflowsService.startBackfill', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects a request whose session does not belong to the claimed account', async () => {
    const accountKey = 'auth-mismatch-1'
    await seedSession(accountKey)
    const svc = service()
    await expect(svc.startBackfill({ sessionId: sessionIdFor(accountKey), accountKey: 'someone-else', requestId: 'req-1' })).rejects.toThrow('Unauthorized')
  })

  it('creates a job and starts the underlying Workflow', async () => {
    const accountKey = 'backfill-1'
    await seedSession(accountKey)
    const svc = service()
    const result = await svc.startBackfill({ sessionId: sessionIdFor(accountKey), accountKey, requestId: 'req-1' })
    expect(result.created).toBe(true)
    expect(result.job.state).toBe('queued')
  })

  it('dedups a retried startBackfill call with the same requestId', async () => {
    const accountKey = 'backfill-2'
    await seedSession(accountKey)
    const svc = service()
    const first = await svc.startBackfill({ sessionId: sessionIdFor(accountKey), accountKey, requestId: 'req-dedup' })
    const retry = await svc.startBackfill({ sessionId: sessionIdFor(accountKey), accountKey, requestId: 'req-dedup' })
    expect(retry.created).toBe(false)
    expect(retry.job.jobId).toBe(first.job.jobId)
  })

  it('rejects a second concurrent backfill for the same account', async () => {
    const accountKey = 'backfill-3'
    await seedSession(accountKey)
    const svc = service()
    await svc.startBackfill({ sessionId: sessionIdFor(accountKey), accountKey, requestId: 'req-a' })
    await expect(svc.startBackfill({ sessionId: sessionIdFor(accountKey), accountKey, requestId: 'req-b' })).rejects.toThrow('already running')
  })

  it('rejects a malformed requestId before touching the index', async () => {
    const accountKey = 'backfill-4'
    await seedSession(accountKey)
    const svc = service()
    await expect(svc.startBackfill({ sessionId: sessionIdFor(accountKey), accountKey, requestId: 'not valid!' })).rejects.toThrow('Invalid request ID')
  })

  it('rejects a scope containing a non-date entry', async () => {
    const accountKey = 'backfill-5'
    await seedSession(accountKey)
    const svc = service()
    await expect(svc.startBackfill({ sessionId: sessionIdFor(accountKey), accountKey, requestId: 'req-scope', scope: ['2026-01-01', 'not-a-date'] })).rejects.toThrow('Invalid backfill scope')
  })

  it('refuses to start a new backfill once the daily step budget is exhausted', async () => {
    const accountKey = 'backfill-budget-1'
    await seedSession(accountKey)
    const workflowEnv = env as unknown as WorkflowEnv
    const usageStub = workflowEnv.S3_SYNC_INDEX.getByName('__workflow_usage__')
    const today = new Date().toISOString().slice(0, 10)
    await runInDurableObject(usageStub, (instance: S3SyncIndex) => {
      for (let i = 0; i < DAILY_WORKFLOW_STEP_BUDGET; i += 1) instance.recordWorkflowStep(today)
    })

    const svc = service()
    await expect(svc.startBackfill({ sessionId: sessionIdFor(accountKey), accountKey, requestId: 'req-budget' })).rejects.toThrow('budget')

    // No job should have been reserved for this account as a side effect of the refusal.
    const index = workflowEnv.S3_SYNC_INDEX.getByName(accountKey)
    expect(await runInDurableObject(index, (instance: S3SyncIndex) => instance.getJob())).toBeNull()
  })
})

describe('S3WorkflowsService auth scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('getJob refuses a mismatched accountKey', async () => {
    const accountKey = 'entry-auth-1'
    await seedSession(accountKey)
    const svc = service()
    await expect(svc.getJob({ sessionId: sessionIdFor(accountKey), accountKey: 'not-the-owner' })).rejects.toThrow('Unauthorized')
  })

  it('getEntryStatus refuses a mismatched accountKey', async () => {
    const accountKey = 'entry-auth-2'
    await seedSession(accountKey)
    const svc = service()
    await expect(svc.getEntryStatus({ sessionId: sessionIdFor(accountKey), accountKey: 'not-the-owner', date: '2026-01-01', requestedVersion: '1' })).rejects.toThrow('Unauthorized')
  })

  it('getEntryStatus rejects a malformed date before touching the index', async () => {
    const accountKey = 'entry-auth-3'
    await seedSession(accountKey)
    const svc = service()
    await expect(svc.getEntryStatus({ sessionId: sessionIdFor(accountKey), accountKey, date: 'not-a-date', requestedVersion: '1' })).rejects.toThrow('Invalid date')
  })

  it('getEntryStatus reports disabled until setBackupEnabled(true) has run', async () => {
    const accountKey = 'entry-auth-4'
    await seedSession(accountKey)
    const svc = service()
    const status = await svc.getEntryStatus({ sessionId: sessionIdFor(accountKey), accountKey, date: '2026-01-01', requestedVersion: '1' })
    expect(status.status).toBe('disabled')
  })
})

describe('S3WorkflowsService.getWorkflowUsage', () => {
  it('reports the configured daily budget', async () => {
    const svc = service()
    const usage = await svc.getWorkflowUsage()
    expect(usage.budget).toBe(DAILY_WORKFLOW_STEP_BUDGET)
    expect(usage.remaining).toBe(Math.max(0, usage.budget - usage.steps))
  })
})

describe('S3WorkflowsService single-entry mirror RPCs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('mirrorEntryNow mirrors inline and reports success', async () => {
    const accountKey = 'mirror-now-1'
    await seedSession(accountKey)
    const svc = service()
    const result = await svc.mirrorEntryNow({ sessionId: sessionIdFor(accountKey), accountKey, date: '2026-07-01' })
    expect(result.ok).toBe(true)

    const index = (env as unknown as WorkflowEnv).S3_SYNC_INDEX.getByName(accountKey)
    const entry = await runInDurableObject(index, (instance: S3SyncIndex) => instance.getEntry('2026-07-01'))
    expect(entry?.state).toBe('synced')
  })

  it('mirrorEntryNow records a permanent failure and reports it', async () => {
    const accountKey = 'mirror-now-2'
    await seedSession(accountKey)
    vi.mocked(drive.findEntryMeta).mockImplementationOnce(async () => {
      throw Object.assign(new Error('forbidden'), { status: 403 })
    })
    const svc = service()
    const result = await svc.mirrorEntryNow({ sessionId: sessionIdFor(accountKey), accountKey, date: '2026-07-02' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('forbidden')

    const index = (env as unknown as WorkflowEnv).S3_SYNC_INDEX.getByName(accountKey)
    const entry = await runInDurableObject(index, (instance: S3SyncIndex) => instance.getEntry('2026-07-02'))
    expect(entry?.state).toBe('failed')
  })

  it('mirrorEntry marks the entry pending and schedules a mirror workflow without running it inline', async () => {
    const accountKey = 'mirror-ff-1'
    await seedSession(accountKey)
    const workflowEnv = {
      ...(env as unknown as WorkflowEnv),
      S3_MIRROR_WORKFLOW: {
        create: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockRejectedValue(new Error('not found')),
      },
    } as unknown as WorkflowEnv
    const svc = new S3WorkflowsService(createExecutionContext(), workflowEnv)

    const result = await svc.mirrorEntry({ sessionId: sessionIdFor(accountKey), accountKey, date: '2026-07-03', driveVersion: '9' })
    expect(result.ok).toBe(true)
    expect(workflowEnv.S3_MIRROR_WORKFLOW.create).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ date: '2026-07-03', driveVersion: '9', kind: 'mirror' }),
      }),
    )

    const index = (env as unknown as WorkflowEnv).S3_SYNC_INDEX.getByName(accountKey)
    const entry = await runInDurableObject(index, (instance: S3SyncIndex) => instance.getEntry('2026-07-03'))
    expect(entry?.state).toBe('pending')
    expect(entry?.driveVersion).toBe('9')
  })

  it('deleteEntry schedules a delete workflow', async () => {
    const accountKey = 'del-ff-1'
    await seedSession(accountKey)
    const workflowEnv = {
      ...(env as unknown as WorkflowEnv),
      S3_MIRROR_WORKFLOW: {
        create: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockRejectedValue(new Error('not found')),
      },
    } as unknown as WorkflowEnv
    const svc = new S3WorkflowsService(createExecutionContext(), workflowEnv)

    const result = await svc.deleteEntry({ sessionId: sessionIdFor(accountKey), accountKey, date: '2026-07-04' })
    expect(result.ok).toBe(true)
    expect(workflowEnv.S3_MIRROR_WORKFLOW.create).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ date: '2026-07-04', kind: 'delete' }),
      }),
    )
  })
})

describe('getEntryStatus lazy mirror-on-read', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function lazyEnv() {
    return {
      ...(env as unknown as WorkflowEnv),
      S3_MIRROR_WORKFLOW: {
        create: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockRejectedValue(new Error('not found')),
      },
    } as unknown as WorkflowEnv
  }

  it('starts a mirror workflow and reports pending when a plain open finds no index record', async () => {
    const accountKey = 'lazy-open-1'
    await seedSession(accountKey)
    const workflowEnv = lazyEnv()
    const svc = new S3WorkflowsService(createExecutionContext(), workflowEnv)
    await svc.setBackupEnabled({ sessionId: sessionIdFor(accountKey), accountKey, enabled: true })

    const status = await svc.getEntryStatus({ sessionId: sessionIdFor(accountKey), accountKey, date: '2026-01-05', requestedVersion: '7' })
    expect(status.status).toBe('pending')
    expect(workflowEnv.S3_MIRROR_WORKFLOW.create).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ date: '2026-01-05', kind: 'mirror' }),
      }),
    )

    const index = (env as unknown as WorkflowEnv).S3_SYNC_INDEX.getByName(accountKey)
    const entry = await runInDurableObject(index, (instance: S3SyncIndex) => instance.getEntry('2026-01-05'))
    expect(entry?.state).toBe('pending')
  })

  it('does not auto-mirror on a since-scoped check past its grace window (the client auto-retries)', async () => {
    const accountKey = 'lazy-open-2'
    await seedSession(accountKey)
    const workflowEnv = lazyEnv()
    const svc = new S3WorkflowsService(createExecutionContext(), workflowEnv)
    await svc.setBackupEnabled({ sessionId: sessionIdFor(accountKey), accountKey, enabled: true })

    const status = await svc.getEntryStatus({
      sessionId: sessionIdFor(accountKey),
      accountKey,
      date: '2026-01-06',
      requestedVersion: '7',
      since: new Date(Date.now() - 60 * 1000).toISOString(),
    })
    expect(status.status).toBe('unconfirmed')
    expect(workflowEnv.S3_MIRROR_WORKFLOW.create).not.toHaveBeenCalled()
  })

  it('re-arms the mirror and reports pending when a plain open finds a stale pending record', async () => {
    const accountKey = 'lazy-open-3'
    await seedSession(accountKey)
    const index = (env as unknown as WorkflowEnv).S3_SYNC_INDEX.getByName(accountKey)
    await runInDurableObject(index, (instance: S3SyncIndex) => {
      instance.setBackupEnabled(true)
      instance.markPending('2026-01-07', '3', new Date(Date.now() - 10 * 60 * 1000).toISOString())
    })
    const workflowEnv = lazyEnv()
    const svc = new S3WorkflowsService(createExecutionContext(), workflowEnv)

    const status = await svc.getEntryStatus({ sessionId: sessionIdFor(accountKey), accountKey, date: '2026-01-07', requestedVersion: '3' })
    expect(status.status).toBe('pending')
    expect(workflowEnv.S3_MIRROR_WORKFLOW.create).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ date: '2026-01-07', kind: 'mirror' }),
      }),
    )
  })
})
