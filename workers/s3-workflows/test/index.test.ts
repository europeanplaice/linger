import { createExecutionContext, env, runInDurableObject } from 'cloudflare:test'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionData } from '../../../functions/_shared/session'
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
