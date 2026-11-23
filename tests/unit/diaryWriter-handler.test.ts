import { describe, expect, it, vi } from 'vitest'
import { onRequestPost, onRequestDelete } from '../../functions/api/drive/entry/[date]'
import { onRequestPost as onUpload } from '../../functions/api/drive/upload/[date]'

function context(method: string, body?: string, headers?: HeadersInit) {
  const mutateDiaryEntry = vi.fn(async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } }))
  const uploadDiaryEntry = vi.fn(async () => ({ status: 200, body: { uploadUrl: 'test-url' } }))
  return {
    request: new Request('https://example.com/api/drive/entry/2026-10-31', { method, body, headers }),
    params: { date: '2026-10-31' },
    data: { sessionId: 'session-a', session: { google_sub: 'google-a', user_id: 'account-a', vault_key: 'request-key' } },
    env: { S3_WORKFLOW_SERVICE: { mutateDiaryEntry, uploadDiaryEntry } }, mutateDiaryEntry, uploadDiaryEntry,
  }
}

describe('Pages to coordinated diary writer', () => {
  it('forwards saves with the random authenticated internal ID and full conflict preconditions', async () => {
    const body = JSON.stringify({ content: 'private', fileId: 'file-a', baseVersion: '7' })
    const ctx = context('POST', body)
    expect((await onRequestPost(ctx as never)).status).toBe(200)
    expect(ctx.mutateDiaryEntry).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-a', accountKey: 'account-a', vaultKey: 'request-key', date: '2026-10-31', method: 'POST', body }))
  })

  it('forwards the exact deletion target and version', async () => {
    const ctx = context('DELETE', undefined, { 'X-Linger-File-Id': 'old-file', 'If-Match': '7' })
    await onRequestDelete(ctx as never)
    expect(ctx.mutateDiaryEntry).toHaveBeenCalledWith(expect.objectContaining({ method: 'DELETE', fileId: 'old-file', baseVersion: '7' }))
  })

  it('fails closed when the writer binding is unavailable', async () => {
    const ctx = context('POST', '{}')
    expect((await onRequestPost({ ...ctx, env: {} } as never)).status).toBe(503)
    expect(ctx.mutateDiaryEntry).not.toHaveBeenCalled()
  })

  it('returns a retryable failure when the writer fails', async () => {
    const ctx = context('POST', '{}')
    ctx.mutateDiaryEntry.mockRejectedValueOnce(new Error('unavailable'))
    expect((await onRequestPost(ctx as never)).status).toBe(503)
  })

  it('bounds the actual body even without a Content-Length header', async () => {
    const ctx = context('POST', 'x'.repeat(1_000_001))
    expect((await onRequestPost(ctx as never)).status).toBe(413)
    expect(ctx.mutateDiaryEntry).not.toHaveBeenCalled()
  })

  it('rejects an invalid date before contacting the coordinator', async () => {
    const ctx = context('DELETE')
    expect((await onRequestDelete({ ...ctx, params: { date: 'invalid' } } as never)).status).toBe(400)
    expect(ctx.mutateDiaryEntry).not.toHaveBeenCalled()
  })
})

describe('direct upload instructions', () => {
  it('forwards authorized metadata to the writer', async () => {
    const body = { action: 'prepare', operationId: crypto.randomUUID(), bytes: 5, baseVersion: '7' }
    const ctx = context('POST', JSON.stringify(body), { Origin: 'https://example.com' })

    const response = await onUpload(ctx as never)
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.json()).toEqual({ uploadUrl: 'test-url' })
    expect(ctx.uploadDiaryEntry).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      ...body, sessionId: 'session-a', accountKey: 'account-a', date: '2026-10-31', origin: 'https://example.com',
    }))
    expect(ctx.mutateDiaryEntry).not.toHaveBeenCalled()
  })

  it('rejects a diary body in the upload-instruction request', async () => {
    const ctx = context('POST', JSON.stringify({
      action: 'prepare', operationId: crypto.randomUUID(), bytes: 6, content: 'private',
    }))

    expect((await onUpload(ctx as never)).status).toBe(400)
    expect(ctx.uploadDiaryEntry).not.toHaveBeenCalled()
  })
})
