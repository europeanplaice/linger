import { env, introspectWorkflowInstance, runInDurableObject } from 'cloudflare:test'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { putObjectIfNewer } from '../../../functions/_shared/s3'
import type { SessionData } from '../../../functions/_shared/session'
import { WORKFLOW_CHUNK_SIZE } from '../src/workflow'
import type { S3Config } from '../src/runtime'
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
  getDiaryFileMeta: vi.fn(async (_token: string, _sessionId: string, _session: unknown, _env: unknown, fileId: string) => {
    if (fileId === 'missing') throw Object.assign(new Error('not_found'), { status: 404 })
    return { id: fileId, name: `diary-${fileId}.txt`, version: `${fileId}-v1` }
  }),
  getEntryContent: vi.fn(async (_token: string, fileId: string) => ({ date: fileId, content: `content for ${fileId}` })),
  listEntryPage: vi.fn(async () => ({ files: [], nextPageToken: undefined })),
}))

vi.mock('../../../functions/_shared/s3', () => ({
  isAtLeast: (existing: string, incoming: string) => {
    try { return BigInt(existing) >= BigInt(incoming) } catch { return false }
  },
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

async function runScopedWorkflow(accountKey: string, jobId: string, workflowId: string, scope: string[], config?: S3Config) {
  const workflowEnv = env as unknown as WorkflowEnv
  await seedSession(accountKey)
  const index = workflowEnv.S3_SYNC_INDEX.getByName(accountKey)
  await runInDurableObject(index, (instance: S3SyncIndex) => {
    instance.setBackupEnabled(true)
    instance.startJob(`req-${jobId}`, jobId, workflowId, true, new Date().toISOString())
  })

  const params: S3BackfillParams = { sessionId: SESSION_ID, accountKey, jobId, scope: scope.map(date => ({ date })), ...(config ? { config } : {}) }
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

    // A single-batch scoped run makes exactly 3 named steps: mark-job-running
    // (setTotal is folded into this same step — see the scope branch in
    // workflow.ts, where step 1 sets the total instead of a separate step),
    // backup-batch-scope-0 (recordProgress is folded into this same step rather
    // than a separate one), and mark-job-finished.
    const after = await runInDurableObject(usageStub, (instance: S3SyncIndex) => instance.getWorkflowStepUsage(today))
    expect(after - before).toBe(3)
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

  it('guards every S3 write with the HEAD-based update path, even for dates the index has never seen', async () => {
    // Regression guard: a Resync wipes the DO index (resetAllData), so every date
    // looks unknown here. The old index-derived hint then sent expectExisting=false
    // (a bare If-None-Match: * create) for every entry — and under bucket versioning
    // that always succeeds as a new version, appending a duplicate version of each
    // unchanged entry on every Resync. The write must always carry the HEAD guard
    // that turns an already-current object into a skip instead of a re-create.
    await runScopedWorkflow('8888888888', 'job-scope-8', 'wf-scope-8', ['2026-05-01', '2026-05-02'])

    const optionsArgs = vi.mocked(putObjectIfNewer).mock.calls.map(c => c[7])
    expect(optionsArgs.length).toBeGreaterThan(0)
    for (const options of optionsArgs) {
      expect(options).toEqual({ expectExisting: true })
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

  it('keeps one Workflow instance inside the 50-subrequest pool for a full chunk of new entries', { timeout: 60_000 }, async () => {
    // A full WORKFLOW_CHUNK_SIZE (12) scope = exactly one Workflow instance, which
    // pools all of its Drive/S3/STS fetches against the Free plan's 50-subrequest
    // per-instance budget (see workflow.ts's chunk-size comment for the accounting).
    // Pinning the exact per-entry call count means an accidental extra Drive or S3
    // round trip per entry fails here before it can quietly push a chunk over the
    // pool limit. Config is frozen into params at start (as startBackfill does), so
    // the workflow must not re-read Drive settings on every batch.
    const config: S3Config = { enabled: true, roleArn: 'arn:aws:iam::123456789012:role/linger', bucket: 'my-bucket', region: 'us-east-1' }
    const scope = Array.from({ length: WORKFLOW_CHUNK_SIZE }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`)
    await runScopedWorkflow('101010101010', 'job-pool-1', 'wf-pool-1', scope, config)

    const drive = await import('../../../functions/_shared/drive')
    const s3 = await import('../../../functions/_shared/s3')
    // Per entry: findEntryMeta (name → id) + getEntryContent + one S3 write.
    // No other Drive/S3 calls may creep into the per-entry path.
    expect(vi.mocked(drive.findEntryMeta).mock.calls.length).toBe(WORKFLOW_CHUNK_SIZE)
    expect(vi.mocked(drive.getEntryContent).mock.calls.length).toBe(WORKFLOW_CHUNK_SIZE)
    expect(vi.mocked(s3.putObjectIfNewer).mock.calls.length).toBe(WORKFLOW_CHUNK_SIZE)
    expect(vi.mocked(drive.getDiaryFileMeta).mock.calls.length).toBe(0)
    expect(vi.mocked(drive.ensureFolder).mock.calls.length).toBe(0)
    expect(vi.mocked(drive.findJsonFile).mock.calls.length).toBe(0)
    expect(vi.mocked(drive.readJsonFile).mock.calls.length).toBe(0)
    // Per instance: at most one STS assume-role (the KV-backed credential cache
    // absorbs the second batch), so a full chunk costs CHUNK x 3 + 1 < 50 — which
    // is exactly why the 50 bound below has no slack: raising CHUNK or adding any
    // per-entry call must fail this guard.
    expect(vi.mocked(s3.assumeRoleWithWebIdentity).mock.calls.length).toBe(1)
    const total = (
      vi.mocked(drive.findEntryMeta).mock.calls.length
      + vi.mocked(drive.getEntryContent).mock.calls.length
      + vi.mocked(drive.getDiaryFileMeta).mock.calls.length
      + vi.mocked(drive.ensureFolder).mock.calls.length
      + vi.mocked(drive.findJsonFile).mock.calls.length
      + vi.mocked(drive.readJsonFile).mock.calls.length
      + vi.mocked(drive.listEntryPage).mock.calls.length
      + vi.mocked(s3.assumeRoleWithWebIdentity).mock.calls.length
      + vi.mocked(s3.putObjectIfNewer).mock.calls.length
      + vi.mocked(s3.deleteObject).mock.calls.length
    )
    expect(total).toBeLessThanOrEqual(50)
  })
})
