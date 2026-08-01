import { env, introspectWorkflowInstance, runInDurableObject } from 'cloudflare:test'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { putObjectIfNewer } from '../../../functions/_shared/s3'
import type { SessionData } from '../../../functions/_shared/session'
import type { S3SyncIndex } from '../src/syncIndex'
import type { WorkflowEnv, S3BackfillParams } from '../src/types'

vi.mock('../../../functions/_shared/drive', () => ({
  ensureFolder: vi.fn(async () => 'folder-1'),
  findJsonFile: vi.fn(async () => 'settings-file-1'),
  readJsonFile: vi.fn(async () => ({ enabled: true, roleArn: 'arn:aws:iam::123456789012:role/linger', bucket: 'my-bucket', region: 'us-east-1' })),
  // A scope-based backfill (this file only exercises that path) looks up each date's
  // current fileId via findEntryMeta — it never knows a fileId up front, unlike the
  // paging-discovery path which carries one straight from the listing.
  findEntryMeta: vi.fn(async (_token: string, _sessionId: string, _session: unknown, _env: unknown, date: string) => {
    if (date === 'missing') return null
    if (date === 'broken') throw Object.assign(new Error('forbidden'), { status: 403 })
    return { id: date, name: `diary-${date}.txt`, version: `${date}-v1` }
  }),
  getEntryContent: vi.fn(async (_token: string, fileId: string) => ({ date: fileId, content: `content for ${fileId}` })),
  listEntryPage: vi.fn(async () => ({ files: [], nextPageToken: undefined })),
}))

vi.mock('../../../functions/_shared/s3', () => ({
  assumeRoleWithWebIdentity: vi.fn(async () => ({ accessKeyId: 'AKIA_FAKE', secretAccessKey: 'fake-secret', sessionToken: 'fake-session-token', expiresAt: Date.now() + 3600_000 })),
  putObjectIfNewer: vi.fn(async () => undefined),
  deleteObject: vi.fn(async () => undefined),
  describeError: (e: unknown) => (e instanceof Error ? e.message : 'Unknown error'),
  // assumeS3Credentials now routes through s3Settings.ts's getAssumedCredentials
  // (a KV-session-backed cache in front of assumeRoleWithWebIdentity, see
  // runtime.ts), which imports this constant directly from the real (unmocked)
  // s3Settings.ts — so this mock of its dependency module needs to provide it too.
  CREDENTIALS_EXPIRY_MARGIN_MS: 15 * 60 * 1000,
}))

const SESSION_ID = 'test-session'

async function seedSession(accountKey: string) {
  const session: SessionData = {
    refresh_token: 'refresh',
    access_token: 'access',
    expires_at: Date.now() + 3600_000,
    id_token: 'id-token',
    google_sub: accountKey,
  }
  await env.SESSIONS.put(`session:${SESSION_ID}`, JSON.stringify(session))
}

async function runScopedWorkflow(accountKey: string, jobId: string, workflowId: string, scope: string[]) {
  const workflowEnv = env as unknown as WorkflowEnv
  await seedSession(accountKey)
  const index = workflowEnv.S3_SYNC_INDEX.getByName(accountKey)
  await runInDurableObject(index, (instance: S3SyncIndex) => {
    instance.setBackupEnabled(true)
    instance.startJob(`req-${jobId}`, jobId, workflowId, true, new Date().toISOString())
  })

  const params: S3BackfillParams = { sessionId: SESSION_ID, accountKey, jobId, scope: scope.map(date => ({ date })) }
  let currentWfId = workflowId
  let chunkIdx = 1
  while (currentWfId) {
    await using instance = await introspectWorkflowInstance(workflowEnv.S3_BACKFILL_WORKFLOW, currentWfId)
    if (chunkIdx === 1) {
      await workflowEnv.S3_BACKFILL_WORKFLOW.create({ id: currentWfId, params })
    }
    await instance.waitForStatus('complete')
    const job = await runInDurableObject(index, (inst: S3SyncIndex) => inst.getJob(jobId))
    if (job?.state === 'complete' || job?.state === 'failed') break
    currentWfId = `${jobId}-chunk-${chunkIdx++}`
  }

  return index
}

describe('S3BackfillWorkflow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('processes a scoped backfill in batches and marks the job complete', { timeout: 40_000 }, async () => {
    const accountKey = '1111111111'
    const scope = Array.from({ length: 25 }, (_, i) => `2026-01-${String(i + 1).padStart(2, '0')}`)
    const index = await runScopedWorkflow(accountKey, 'job-scope-1', 'wf-scope-1', scope)

    const job = await runInDurableObject(index, (instance: S3SyncIndex) => instance.getJob('job-scope-1'))
    expect(job?.state).toBe('complete')
    expect(job?.completed).toBe(25)
    expect(job?.failedDates).toEqual([])

    const firstEntry = await runInDurableObject(index, (instance: S3SyncIndex) => instance.getEntry(scope[0]))
    expect(firstEntry?.state).toBe('synced')
    expect(firstEntry?.syncedVersion).toBe(`${scope[0]}-v1`)
  })

  it('isolates a permanently-failing entry without failing the whole batch', async () => {
    const accountKey = '2222222222'
    const index = await runScopedWorkflow(accountKey, 'job-scope-2', 'wf-scope-2', ['2026-02-01', 'broken'])

    const job = await runInDurableObject(index, (instance: S3SyncIndex) => instance.getJob('job-scope-2'))
    expect(job?.state).toBe('failed')
    expect(job?.failedDates).toEqual(['broken'])
    expect(job?.completed).toBe(2)

    const okEntry = await runInDurableObject(index, (instance: S3SyncIndex) => instance.getEntry('2026-02-01'))
    expect(okEntry?.state).toBe('synced')
    const brokenEntry = await runInDurableObject(index, (instance: S3SyncIndex) => instance.getEntry('broken'))
    expect(brokenEntry?.state).toBe('failed')
  })

  it('treats a missing Drive entry as deleted rather than failed', async () => {
    const accountKey = '5555555555'
    const index = await runScopedWorkflow(accountKey, 'job-scope-5', 'wf-scope-5', ['missing'])

    const job = await runInDurableObject(index, (instance: S3SyncIndex) => instance.getJob('job-scope-5'))
    expect(job?.state).toBe('complete')
    expect(job?.failedDates).toEqual([])
    expect(await runInDurableObject(index, (instance: S3SyncIndex) => instance.getEntry('missing'))).toBeNull()
  })

  it('records exactly one workflow-usage step per Workflow step', async () => {
    const workflowEnv = env as unknown as WorkflowEnv
    const usageStub = workflowEnv.S3_SYNC_INDEX.getByName('__workflow_usage__')
    const today = new Date().toISOString().slice(0, 10)
    const before = await runInDurableObject(usageStub, (instance: S3SyncIndex) => instance.getWorkflowStepUsage(today))

    await runScopedWorkflow('6666666666', 'job-scope-6', 'wf-scope-6', ['2026-03-01'])

    // A single-batch scoped run makes exactly 4 named steps: mark-job-running,
    // set-scope-total, backup-batch-scope-0 (recordProgress is folded into this
    // same step rather than a separate one — see workflow.ts's processBatch),
    // mark-job-finished.
    const after = await runInDurableObject(usageStub, (instance: S3SyncIndex) => instance.getWorkflowStepUsage(today))
    expect(after - before).toBe(4)
  })

  it('never stores the access token, id token, or AWS credentials in the sync index', async () => {
    const accountKey = '7777777777'
    const index = await runScopedWorkflow(accountKey, 'job-scope-7', 'wf-scope-7', ['2026-04-01', 'broken'])

    const job = await runInDurableObject(index, (instance: S3SyncIndex) => instance.getJob('job-scope-7'))
    const entry1 = await runInDurableObject(index, (instance: S3SyncIndex) => instance.getEntry('2026-04-01'))
    const entryBroken = await runInDurableObject(index, (instance: S3SyncIndex) => instance.getEntry('broken'))
    const dump = JSON.stringify({ job, entry1, entryBroken })
    for (const secret of ['id-token', 'access', 'refresh', 'AKIA_FAKE', 'fake-secret', 'fake-session-token']) {
      expect(dump).not.toContain(secret)
    }
  })

  it('derives expectExisting=false from a DO index that has never seen the date (first mirror)', async () => {
    // Fresh account: the index has no synced record for any scope date, so the S3
    // write must be told expectExisting=false (an If-None-Match create) rather than
    // paying an unnecessary HEAD.
    await runScopedWorkflow('8888888888', 'job-scope-8', 'wf-scope-8', ['2026-05-01', '2026-05-02'])

    const optionsArgs = vi.mocked(putObjectIfNewer).mock.calls.map(c => c[7])
    expect(optionsArgs.length).toBeGreaterThan(0)
    for (const options of optionsArgs) {
      expect(options).toEqual({ expectExisting: false })
    }
  })

  it('derives expectExisting=true for dates the DO index already knows are synced', async () => {
    const accountKey = '9999999999'
    const workflowEnv = env as unknown as WorkflowEnv
    const index = workflowEnv.S3_SYNC_INDEX.getByName(accountKey)
    await runInDurableObject(index, (instance: S3SyncIndex) => {
      instance.markSynced('2026-06-01', '2026-06-01-v1', new Date().toISOString())
    })
    await runScopedWorkflow(accountKey, 'job-scope-9', 'wf-scope-9', ['2026-06-01'])

    const thisDateCalls = vi.mocked(putObjectIfNewer).mock.calls.filter(c => String(c[3]).includes('2026-06-01'))
    expect(thisDateCalls.length).toBeGreaterThan(0)
    for (const call of thisDateCalls) {
      expect(call[7]).toEqual({ expectExisting: true })
    }
  })
})
