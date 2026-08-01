import { env, introspectWorkflowInstance, runInDurableObject } from 'cloudflare:test'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionData } from '../../../functions/_shared/session'
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
  getEntryContent: vi.fn(async (_token: string, fileId: string) => ({ date: fileId.replace('file-', ''), content: 'hello' })),
  listEntryPage: vi.fn(async () => ({ files: [], nextPageToken: undefined })),
}))

vi.mock('../../../functions/_shared/s3', () => ({
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

  it('records exactly two workflow-usage steps per instance (mark-pending + mirror)', { timeout: 40_000 }, async () => {
    const workflowEnv = env as unknown as WorkflowEnv
    const usageStub = workflowEnv.S3_SYNC_INDEX.getByName('__workflow_usage__')
    const today = new Date().toISOString().slice(0, 10)
    const before = await runInDurableObject(usageStub, (instance: S3SyncIndex) => instance.getWorkflowStepUsage(today))

    await runMirrorWorkflow('6666666666', 'mirror-wf-6', { date: '2026-07-01', kind: 'mirror' })

    const after = await runInDurableObject(usageStub, (instance: S3SyncIndex) => instance.getWorkflowStepUsage(today))
    expect(after - before).toBe(2)
  })
})
