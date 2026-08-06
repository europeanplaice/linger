import { env, introspectWorkflowInstance, runInDurableObject } from 'cloudflare:test'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssumedCredentials } from '../../../functions/_shared/s3'
import type { SessionData } from '../../../functions/_shared/session'
import { convergeMirror, DAILY_WORKFLOW_STEP_BUDGET, deleteEntryForAuth, mirrorEntryForAuth, type S3Config } from '../src/runtime'
import type { S3SyncIndex } from '../src/syncIndex'
import type { MirrorWorkflowParams, WorkflowEnv } from '../src/types'

vi.mock('../../../functions/_shared/drive', () => ({
  ensureFolder: vi.fn(async () => 'folder-1'),
  findJsonFile: vi.fn(async () => 'settings-file-1'),
  readJsonFile: vi.fn(async () => ({ enabled: true, roleArn: 'arn:aws:iam::123456789012:role/linger', bucket: 'my-bucket', region: 'us-east-1' })),
  findEntryMeta: vi.fn(async (_token: string, _sessionId: string, _session: unknown, _env: unknown, date: string) => {
    if (date === 'missing') return null
    if (date === 'broken') throw Object.assign(new Error('forbidden'), { status: 403 })
    return { id: `file-${date}`, name: `diary-${date}.txt`, version: '7' }
  }),
  getDiaryFileMeta: vi.fn(async (_token: string, _sessionId: string, _session: unknown, _env: unknown, fileId: string) => {
    if (fileId === 'missing') throw Object.assign(new Error('not_found'), { status: 404 })
    return { id: fileId, name: `diary-${fileId}.txt`, version: '7' }
  }),
  getEntryContent: vi.fn(async (_token: string, fileId: string) => ({ date: fileId.replace('file-', ''), content: 'hello' })),
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
  // assumeS3Credentials routes through s3Settings.ts's getAssumedCredentials,
  // which imports this constant from the real (unmocked) module — see the same
  // note in workflow.test.ts.
  CREDENTIALS_EXPIRY_MARGIN_MS: 15 * 60 * 1000,
}))

const SESSION_ID = 'test-session'

async function seedSession(accountKey: string) {
  const session: SessionData = {
    refresh_token: 'refresh',
    access_token: 'access',
    expires_at: Date.now() + 3600_000,
    id_token: 'id-token',
    id_token_verified: true,
    google_sub: accountKey,
  }
  await env.SESSIONS.put(`session:${SESSION_ID}`, JSON.stringify(session))
}

async function runMirrorWorkflow(
  accountKey: string,
  workflowId: string,
  params: Omit<MirrorWorkflowParams, 'sessionId' | 'accountKey'>,
  indexStub?: ReturnType<WorkflowEnv['S3_SYNC_INDEX']['getByName']>,
) {
  const workflowEnv = env as unknown as WorkflowEnv
  await seedSession(accountKey)
  await using instance = await introspectWorkflowInstance(workflowEnv.S3_MIRROR_WORKFLOW, workflowId)
  await workflowEnv.S3_MIRROR_WORKFLOW.create({ id: workflowId, params: { sessionId: SESSION_ID, accountKey, ...params } })
  await instance.waitForStatus('complete')
  return indexStub ?? workflowEnv.S3_SYNC_INDEX.getByName(accountKey)
}

describe('S3MirrorWorkflow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('mirrors an entry and marks it synced', { timeout: 40_000 }, async () => {
    const accountKey = '1111111111'
    const index = await runMirrorWorkflow(accountKey, 'mirror-wf-1', { date: '2026-05-01', kind: 'mirror' })
    const entry = await runInDurableObject(index, (instance: S3SyncIndex) => instance.getEntry('2026-05-01'))
    expect(entry?.state).toBe('synced')
    expect(entry?.syncedVersion).toBe('7')
  })

  it('removes the object and the index record for a delete', { timeout: 40_000 }, async () => {
    const accountKey = '2222222222'
    const index = await runMirrorWorkflow(accountKey, 'mirror-wf-2', { date: '2026-05-02', kind: 'delete' })
    expect(await runInDurableObject(index, (instance: S3SyncIndex) => instance.getEntry('2026-05-02'))).toBeNull()
    const { deleteObject } = await import('../../../functions/_shared/s3')
    expect(vi.mocked(deleteObject)).toHaveBeenCalled()
  })

  it('records a permanent 4xx as the entry failure instead of retrying it', { timeout: 40_000 }, async () => {
    const accountKey = '3333333333'
    const index = await runMirrorWorkflow(accountKey, 'mirror-wf-3', { date: 'broken', kind: 'mirror' })
    const entry = await runInDurableObject(index, (instance: S3SyncIndex) => instance.getEntry('broken'))
    expect(entry?.state).toBe('failed')
    expect(entry?.lastError).toContain('forbidden')
  })

  it('treats a missing Drive entry as deleted rather than failed', { timeout: 40_000 }, async () => {
    const accountKey = '4444444444'
    const index = await runMirrorWorkflow(accountKey, 'mirror-wf-4', { date: 'missing', kind: 'mirror' })
    expect(await runInDurableObject(index, (instance: S3SyncIndex) => instance.getEntry('missing'))).toBeNull()
  })

  it('retries a transient failure and eventually marks the entry synced', { timeout: 60_000 }, async () => {
    const accountKey = '5555555555'
    const workflowEnv = env as unknown as WorkflowEnv
    await seedSession(accountKey)
    const index = workflowEnv.S3_SYNC_INDEX.getByName(accountKey)

    // First mirror attempt hits a transient Drive 5xx; the step's retry config
    // then re-runs the whole idempotent mirror, which succeeds.
    const { findEntryMeta } = await import('../../../functions/_shared/drive')
    vi.mocked(findEntryMeta).mockImplementationOnce(async () => {
      throw Object.assign(new Error('upstream 502'), { status: 502 })
    })

    await using instance = await introspectWorkflowInstance(workflowEnv.S3_MIRROR_WORKFLOW, 'mirror-wf-5')
    await workflowEnv.S3_MIRROR_WORKFLOW.create({
      id: 'mirror-wf-5',
      params: { sessionId: SESSION_ID, accountKey, date: '2026-06-01', kind: 'mirror' },
    })
    await instance.waitForStatus('complete')

    const entry = await runInDurableObject(index, (instance: S3SyncIndex) => instance.getEntry('2026-06-01'))
    expect(entry?.state).toBe('synced')
    expect(entry?.syncedVersion).toBe('7')
  })

  it('records exactly one workflow-usage step per instance (the mirror step only)', { timeout: 40_000 }, async () => {
    const workflowEnv = env as unknown as WorkflowEnv
    const usageStub = workflowEnv.S3_SYNC_INDEX.getByName('__workflow_usage__')
    const today = new Date().toISOString().slice(0, 10)
    const before = await runInDurableObject(usageStub, (instance: S3SyncIndex) => instance.getWorkflowStepUsage(today))

    await runMirrorWorkflow('6666666666', 'mirror-wf-6', { date: '2026-07-01', kind: 'mirror' })

    const after = await runInDurableObject(usageStub, (instance: S3SyncIndex) => instance.getWorkflowStepUsage(today))
    expect(after - before).toBe(1)
  })
})

describe('mirror/delete disabled-account gate', () => {
  const workflowEnv = env as unknown as WorkflowEnv

  function spyEnv() {
    return {
      ...workflowEnv,
      S3_MIRROR_WORKFLOW: {
        create: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockRejectedValue(new Error('not found')),
      },
    } as unknown as WorkflowEnv
  }

  it('schedules nothing for a save when backup is explicitly disabled', { timeout: 40_000 }, async () => {
    const accountKey = 'disabled-mirror-1'
    await seedSession(accountKey)
    const index = workflowEnv.S3_SYNC_INDEX.getByName(accountKey)
    await runInDurableObject(index, (instance: S3SyncIndex) => instance.setBackupEnabled(false))
    const workflowEnv2 = spyEnv()

    const result = await mirrorEntryForAuth(workflowEnv2, { sessionId: SESSION_ID, accountKey, date: '2026-08-01', driveVersion: '5' })

    expect(result.ok).toBe(true)
    expect(workflowEnv2.S3_MIRROR_WORKFLOW.create).not.toHaveBeenCalled()
    const entry = await runInDurableObject(index, (instance: S3SyncIndex) => instance.getEntry('2026-08-01'))
    expect(entry).toBeNull()
  })

  it('schedules no delete workflow when backup is disabled', { timeout: 40_000 }, async () => {
    const accountKey = 'disabled-del-1'
    await seedSession(accountKey)
    const index = workflowEnv.S3_SYNC_INDEX.getByName(accountKey)
    await runInDurableObject(index, (instance: S3SyncIndex) => instance.setBackupEnabled(false))
    const workflowEnv2 = spyEnv()

    const result = await deleteEntryForAuth(workflowEnv2, { sessionId: SESSION_ID, accountKey, date: '2026-08-02' })

    expect(result.ok).toBe(true)
    expect(workflowEnv2.S3_MIRROR_WORKFLOW.create).not.toHaveBeenCalled()
    const entry = await runInDurableObject(index, (instance: S3SyncIndex) => instance.getEntry('2026-08-02'))
    expect(entry).toBeNull()
  })
})

describe('versioned-bucket convergence', () => {
  const workflowEnv = env as unknown as WorkflowEnv
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('mirrors at the index\'s newer version when a concurrent save bumped it, instead of writing a stale stamp', { timeout: 40_000 }, async () => {
    const accountKey = '7777777777'
    await seedSession(accountKey)
    const index = workflowEnv.S3_SYNC_INDEX.getByName(accountKey)
    // A newer save (version 9) already owns this date; our mirror only knows 7.
    await runInDurableObject(index, (instance: S3SyncIndex) => {
      instance.setBackupEnabled(true)
      instance.markPending('2026-05-01', '9', new Date().toISOString())
    })

    await runMirrorWorkflow(accountKey, 'mirror-wf-conv-1', { date: '2026-05-01', kind: 'mirror', fileId: 'file-2026-05-01', driveVersion: '7' })

    const entry = await runInDurableObject(index, (instance: S3SyncIndex) => instance.getEntry('2026-05-01'))
    expect(entry?.state).toBe('synced')
    expect(entry?.syncedVersion).toBe('9')
    // Exactly one S3 write, stamped with the newest version — never the stale hint.
    const { putObjectIfNewer } = await import('../../../functions/_shared/s3')
    expect(vi.mocked(putObjectIfNewer)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(putObjectIfNewer).mock.calls[0][5]).toBe('9')
  })

  it('re-mirrors at the newest version when the index knows a newer one than the write that just landed', { timeout: 40_000 }, async () => {
    const accountKey = '8888888888'
    const index = workflowEnv.S3_SYNC_INDEX.getByName(accountKey)
    await runInDurableObject(index, (instance: S3SyncIndex) => {
      instance.setBackupEnabled(true)
      instance.markPending('2026-05-03', '9', new Date().toISOString())
    })
    const config: S3Config = { enabled: true, roleArn: 'arn:aws:iam::123456789012:role/linger', bucket: 'my-bucket', region: 'us-east-1' }
    const creds: AssumedCredentials = { accessKeyId: 'AKIA_FAKE', secretAccessKey: 'fake-secret', sessionToken: 'fake-session-token', expiresAt: Date.now() + 3600_000 }

    await convergeMirror('access-token', index, config, creds, '2026-05-03', 'file-2026-05-03', '7')

    const entry = await runInDurableObject(index, (instance: S3SyncIndex) => instance.getEntry('2026-05-03'))
    expect(entry?.state).toBe('synced')
    expect(entry?.syncedVersion).toBe('9')
    const { putObjectIfNewer } = await import('../../../functions/_shared/s3')
    expect(vi.mocked(putObjectIfNewer)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(putObjectIfNewer).mock.calls[0][5]).toBe('9')
  })

  it('does nothing when the index does not know a newer version than the write that just landed', { timeout: 40_000 }, async () => {
    const accountKey = '9999999999'
    const index = workflowEnv.S3_SYNC_INDEX.getByName(accountKey)
    await runInDurableObject(index, (instance: S3SyncIndex) => {
      instance.setBackupEnabled(true)
      instance.markPending('2026-05-04', '7', new Date().toISOString())
    })
    const config: S3Config = { enabled: true, roleArn: 'arn:aws:iam::123456789012:role/linger', bucket: 'my-bucket', region: 'us-east-1' }
    const creds: AssumedCredentials = { accessKeyId: 'AKIA_FAKE', secretAccessKey: 'fake-secret', sessionToken: 'fake-session-token', expiresAt: Date.now() + 3600_000 }

    await convergeMirror('access-token', index, config, creds, '2026-05-04', 'file-2026-05-04', '7')

    const entry = await runInDurableObject(index, (instance: S3SyncIndex) => instance.getEntry('2026-05-04'))
    expect(entry?.state).toBe('pending')
    expect(entry?.syncedVersion).toBeUndefined()
    const { putObjectIfNewer } = await import('../../../functions/_shared/s3')
    expect(vi.mocked(putObjectIfNewer)).not.toHaveBeenCalled()
  })
})

describe('mirror/delete daily-step budget gate', () => {
  const workflowEnv = env as unknown as WorkflowEnv

  async function exhaustDailyStepBudget() {
    const usageStub = workflowEnv.S3_SYNC_INDEX.getByName('__workflow_usage__')
    const today = new Date().toISOString().slice(0, 10)
    await runInDurableObject(usageStub, (instance: S3SyncIndex) => {
      for (let i = 0; i < DAILY_WORKFLOW_STEP_BUDGET; i += 1) instance.recordWorkflowStep(today)
    })
  }

  it('schedules a mirror normally while the budget remains', { timeout: 60_000 }, async () => {
    const accountKey = 'budget-mirror-ok'
    await seedSession(accountKey)
    const result = await mirrorEntryForAuth(workflowEnv, { sessionId: SESSION_ID, accountKey, date: '2026-06-02', driveVersion: '7' })
    expect(result.ok).toBe(true)

    // Fire-and-forget: the background workflow mirrors and marks the entry synced.
    const index = workflowEnv.S3_SYNC_INDEX.getByName(accountKey)
    for (let i = 0; i < 50; i += 1) {
      const entry = await runInDurableObject(index, (instance: S3SyncIndex) => instance.getEntry('2026-06-02'))
      if (entry?.state === 'synced') break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    const final = await runInDurableObject(index, (instance: S3SyncIndex) => instance.getEntry('2026-06-02'))
    expect(final?.state).toBe('synced')
  })

  it('refuses to schedule a mirror once the daily step budget is exhausted', { timeout: 60_000 }, async () => {
    const accountKey = 'budget-mirror-refused'
    await seedSession(accountKey)
    await exhaustDailyStepBudget()

    const result = await mirrorEntryForAuth(workflowEnv, { sessionId: SESSION_ID, accountKey, date: '2026-06-03', driveVersion: '7' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/budget/i)
    // Nothing was scheduled: no pending record was even written for the date.
    const index = workflowEnv.S3_SYNC_INDEX.getByName(accountKey)
    const entry = await runInDurableObject(index, (instance: S3SyncIndex) => instance.getEntry('2026-06-03'))
    expect(entry).toBeNull()
  })

  it('refuses to schedule a delete once the daily step budget is exhausted', { timeout: 60_000 }, async () => {
    const accountKey = 'budget-delete-refused'
    await seedSession(accountKey)
    await exhaustDailyStepBudget()

    const result = await deleteEntryForAuth(workflowEnv, { sessionId: SESSION_ID, accountKey, date: '2026-06-04' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/budget/i)
    const index = workflowEnv.S3_SYNC_INDEX.getByName(accountKey)
    const entry = await runInDurableObject(index, (instance: S3SyncIndex) => instance.getEntry('2026-06-04'))
    expect(entry).toBeNull()
  })
})

// The budget/disabled gates sit on the save path, so they must FAIL OPEN when the
// bookkeeping DO they read (the account-wide __workflow_usage__ tracker) is
// unavailable: an enabled account's save must never be blocked — with its mirror
// silently dropped — just because the counter hiccupee. The budget-exceeded case is
// still honored (that's an intentional denial, asserted in the gates above); it's only
// an *unexpected* failure to read the counter that degrades to scheduling the mirror.
describe('save-path gate fails open when the usage tracker is unavailable', () => {
  const workflowEnv = env as unknown as WorkflowEnv

  function envWithUnavailableUsage(): { env: WorkflowEnv; createWorkflow: ReturnType<typeof vi.fn> } {
    const createWorkflow = vi.fn().mockResolvedValue(undefined)
    const realIndexNS = workflowEnv.S3_SYNC_INDEX
    const envOverride = {
      ...workflowEnv,
      S3_SYNC_INDEX: {
        getByName: (name: string) =>
          name === '__workflow_usage__'
            ? { getWorkflowStepUsage: async () => { throw new Error('usage tracker unavailable') } }
            : realIndexNS.getByName(name),
      },
      S3_MIRROR_WORKFLOW: { create: createWorkflow, get: vi.fn().mockRejectedValue(new Error('not found')) },
    } as unknown as WorkflowEnv
    return { env: envOverride, createWorkflow }
  }

  it('schedules the mirror (fail-open) when the usage tracker cannot be read', { timeout: 40_000 }, async () => {
    const accountKey = 'failopen-mirror-1'
    await seedSession(accountKey)
    const index = workflowEnv.S3_SYNC_INDEX.getByName(accountKey)
    await runInDurableObject(index, (instance: S3SyncIndex) => instance.setBackupEnabled(true))

    const { env: envOverride, createWorkflow } = envWithUnavailableUsage(accountKey)
    const result = await mirrorEntryForAuth(envOverride, { sessionId: SESSION_ID, accountKey, date: '2026-06-05', driveVersion: '7' })

    expect(result.ok).toBe(true)
    expect(createWorkflow).toHaveBeenCalledTimes(1)
  })

  it('schedules the delete (fail-open) when the usage tracker cannot be read', { timeout: 40_000 }, async () => {
    const accountKey = 'failopen-delete-1'
    await seedSession(accountKey)
    const index = workflowEnv.S3_SYNC_INDEX.getByName(accountKey)
    await runInDurableObject(index, (instance: S3SyncIndex) => instance.setBackupEnabled(true))

    const { env: envOverride, createWorkflow } = envWithUnavailableUsage(accountKey)
    const result = await deleteEntryForAuth(envOverride, { sessionId: SESSION_ID, accountKey, date: '2026-06-06' })

    expect(result.ok).toBe(true)
    expect(createWorkflow).toHaveBeenCalledTimes(1)
  })
})
