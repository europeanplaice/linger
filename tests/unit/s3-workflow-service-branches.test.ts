import { describe, expect, it, vi } from 'vitest'
import { forwardS3Backup } from '../../functions/_shared/s3BackupRequest'

describe('request-scoped backup forwarding', () => {
  it('uses an RPC request without creating a durable Workflow', async () => {
    const backup = vi.fn(async () => new Response('{}'))
    const startBackfill = vi.fn()
    const ctx = { data: { accessToken: 'access', idToken: 'id', sessionId: 'sid', session: { user_id: 'account', vault_key: 'key' } }, env: { S3_WORKFLOW_SERVICE: { backup, startBackfill } } }
    expect((await forwardS3Backup(ctx as any, { kind: 'start' })).status).toBe(200)
    expect(backup).toHaveBeenCalledOnce()
    expect(startBackfill).not.toHaveBeenCalled()
  })
  it('uses the same account DO directly when called from the diary Worker', async () => {
    const backup = vi.fn(async () => new Response('{}'))
    const getByName = vi.fn(() => ({ backup }))
    const ctx = { data: { accessToken: 'access', sessionId: 'sid', session: { user_id: 'account' } }, env: { S3_SYNC_INDEX: { getByName } } }
    await forwardS3Backup(ctx as any, { kind: 'reconcile', date: '2026-01-01' })
    expect(getByName).toHaveBeenCalledWith('account')
    expect(backup).toHaveBeenCalledOnce()
  })
  it('returns unavailable if the coordinator rejects, without exposing provider errors', async () => {
    const backup = vi.fn(async () => { throw new Error('sensitive provider response') })
    const response = await forwardS3Backup({ data: { session: { user_id: 'account' } }, env: { S3_WORKFLOW_SERVICE: { backup } } } as any, { kind: 'start' })
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain('sensitive')
  })
})
