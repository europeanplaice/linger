import { createSession } from '../../../functions/_shared/session'
import { sessionStorageId } from '../../../functions/_shared/authStore'
import { env, introspectWorkflowInstance, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import type { SessionData } from '../../../functions/_shared/session'
import type { S3SyncIndex } from '../src/syncIndex'
import type { WorkflowEnv, S3BackfillParams } from '../src/types'

vi.mock('../../../functions/_shared/drive', async importOriginal => ({
  ...await importOriginal<typeof import('../../../functions/_shared/drive')>(),
  listEntryPage: vi.fn(),
  findEntryMeta: vi.fn(),
  getDiaryFileMeta: vi.fn(),
  getEntryContent: vi.fn(),
}))

vi.mock('../../../functions/_shared/s3', async importOriginal => ({
  ...await importOriginal<typeof import('../../../functions/_shared/s3')>(),
  assumeRoleWithWebIdentity: vi.fn(),
  putObjectIfNewer: vi.fn(),
  deleteObject: vi.fn(),
}))

describe('retired S3BackfillWorkflow', () => {
  it('fails a legacy job closed when D1 contains only account metadata', { timeout: 40_000 }, async () => {
    const accountKey = `legacy-backfill-${crypto.randomUUID()}`
    const sessionId = `session-${accountKey}`
    await createSession(sessionId, { google_sub: accountKey } satisfies SessionData, env)
    const workflowEnv = env as unknown as WorkflowEnv
    const workflowId = `legacy-${crypto.randomUUID()}`
    const params: S3BackfillParams = {
      sessionId,
      accountKey,
      jobId: `job-${crypto.randomUUID()}`,
      scope: [{ date: '2026-04-01' }],
    }

    await using instance = await introspectWorkflowInstance(workflowEnv.S3_BACKFILL_WORKFLOW, workflowId)
    await workflowEnv.S3_BACKFILL_WORKFLOW.create({ id: workflowId, params })
    await instance.waitForStatus('errored')

    const index = workflowEnv.S3_SYNC_INDEX.getByName(accountKey)
    expect(await runInDurableObject(index, (state: S3SyncIndex) => state.getEntry('2026-04-01'))).toBeNull()
    const stored = await env.AUTH_DB.prepare('SELECT data FROM auth_sessions WHERE id = ?').bind(await sessionStorageId(sessionId)).first<{ data: string }>()
    expect(stored!.data).not.toMatch(/access_token|refresh_token|id_token/)
  })
})
