import { createSession } from '../../../functions/_shared/session'
import { env, introspectWorkflowInstance, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import type { S3SyncIndex } from '../src/syncIndex'
import type { MirrorWorkflowParams, WorkflowEnv } from '../src/types'

vi.mock('../../../functions/_shared/drive', async importOriginal => ({
  ...await importOriginal<typeof import('../../../functions/_shared/drive')>(),
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

describe('retired S3MirrorWorkflow', () => {
  it('fails a legacy mirror closed without OAuth credentials and writes no sync record', { timeout: 40_000 }, async () => {
    const accountKey = `legacy-mirror-${crypto.randomUUID()}`
    const sessionId = `session-${accountKey}`
    await createSession(sessionId, { google_sub: accountKey }, env)
    const workflowEnv = env as unknown as WorkflowEnv
    const workflowId = `legacy-${crypto.randomUUID()}`
    const params: MirrorWorkflowParams = { sessionId, accountKey, date: '2026-04-02', kind: 'mirror' }

    await using instance = await introspectWorkflowInstance(workflowEnv.S3_MIRROR_WORKFLOW, workflowId)
    await workflowEnv.S3_MIRROR_WORKFLOW.create({ id: workflowId, params })
    await instance.waitForStatus('errored')

    const index = workflowEnv.S3_SYNC_INDEX.getByName(accountKey)
    expect(await runInDurableObject(index, (state: S3SyncIndex) => state.getEntry('2026-04-02'))).toBeNull()
    const stored = await env.AUTH_DB.prepare('SELECT data FROM auth_sessions WHERE id = ?').bind(sessionId).first<{ data: string }>()
    expect(stored!.data).not.toMatch(/access_token|refresh_token|id_token/)
  })
})
