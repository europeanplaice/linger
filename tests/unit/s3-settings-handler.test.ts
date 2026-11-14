import { describe, expect, it, vi } from 'vitest'
import { onRequestPut } from '../../functions/api/s3/settings'

const config = { enabled: true, roleArn: 'arn:aws:iam::123456789012:role/linger', bucket: 'diary-bucket', region: 'us-east-1' }
function context(body: unknown) {
  const backup = vi.fn(async () => new Response('{"id":"settings"}'))
  return { request: new Request('https://example.com', { method: 'PUT', body: JSON.stringify(body) }), data: { session: { user_id: 'account' } }, env: { S3_WORKFLOW_SERVICE: { backup } } }
}
describe('settings route', () => {
  it('validates settings before forwarding', async () => {
    const ctx = context({ ...config, bucket: 'invalid.bucket' })
    expect((await onRequestPut(ctx as any)).status).toBe(400)
    expect(ctx.env.S3_WORKFLOW_SERVICE.backup).not.toHaveBeenCalled()
  })
  it('strips user-supplied sync progress and forwards only configuration', async () => {
    const ctx = context({ ...config, backfillProgress: { done: 999 } })
    expect((await onRequestPut(ctx as any)).status).toBe(200)
    expect(ctx.env.S3_WORKFLOW_SERVICE.backup).toHaveBeenCalledWith(expect.objectContaining({ operation: { kind: 'settings', config } }))
  })
  it('rejects invalid JSON', async () => {
    const ctx = context(config)
    ctx.request = new Request('https://example.com', { method: 'PUT', body: '{' })
    expect((await onRequestPut(ctx as any)).status).toBe(400)
  })
})
