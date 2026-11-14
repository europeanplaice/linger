import { describe, expect, it, vi } from 'vitest'
import { onRequestPost } from '../../functions/api/s3/backfill-continue'

describe('POST /api/s3/backfill-continue', () => {
  it('forwards the request credentials and waits for the account coordinator', async () => {
    const backup = vi.fn(async () => new Response('{"ok":true}'))
    const ctx = { data: { accessToken: 'access', idToken: 'id', sessionId: 'sid', session: { user_id: 'account', vault_key: 'key', expires_at: 123 } }, env: { S3_WORKFLOW_SERVICE: { backup } } }
    const res = await onRequestPost(ctx as any)
    expect(res.status).toBe(200)
    expect(backup).toHaveBeenCalledWith({ sessionId: 'sid', accountKey: 'account', vaultKey: 'key', accessToken: 'access', idToken: 'id', expiresAt: 123, operation: { kind: 'continue' } })
  })
  it('requires an authenticated account', async () => {
    expect((await onRequestPost({ data: {}, env: {} } as any)).status).toBe(401)
  })
  it('fails closed without a coordinator', async () => {
    expect((await onRequestPost({ data: { session: { user_id: 'account' } }, env: {} } as any)).status).toBe(503)
  })
  it('preserves a coordinator conflict response', async () => {
    const backup = vi.fn(async () => new Response('{"error":"A backfill is already running"}', { status: 409 }))
    const res = await onRequestPost({ data: { session: { user_id: 'account' } }, env: { S3_WORKFLOW_SERVICE: { backup } } } as any)
    expect(res.status).toBe(409)
  })
})
