import { describe, expect, it, vi } from 'vitest'
import { onRequestPost } from '../../functions/api/s3/entry-resync/[date]'

describe('entry resync route', () => {
  it('rejects malformed dates before calling the coordinator', async () => {
    const backup = vi.fn()
    const res = await onRequestPost({ params: { date: 'invalid' }, env: { S3_WORKFLOW_SERVICE: { backup } } } as any)
    expect(res.status).toBe(400)
    expect(backup).not.toHaveBeenCalled()
  })
  it('returns the reconciler failure rather than claiming success', async () => {
    const backup = vi.fn(async () => new Response('{"ok":false}', { status: 502 }))
    const res = await onRequestPost({ params: { date: '2026-01-01' }, data: { session: { user_id: 'account' } }, env: { S3_WORKFLOW_SERVICE: { backup } } } as any)
    expect(res.status).toBe(502)
    expect(backup).toHaveBeenCalledWith(expect.objectContaining({ operation: { kind: 'reconcile', date: '2026-01-01' } }))
  })
})
