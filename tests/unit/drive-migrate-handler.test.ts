import { beforeEach, describe, expect, it, vi } from 'vitest'
import { onRequestPost } from '../../functions/api/drive/migrate'
import * as drive from '../../functions/_shared/drive'
vi.mock('../../functions/_shared/drive', async original => ({ ...await original<typeof import('../../functions/_shared/drive')>(), migrateMdToTxt: vi.fn() }))
beforeEach(() => vi.clearAllMocks())
describe('migration backup scheduling', () => {
  function context(status = 200) {
    const backup = vi.fn(async () => new Response('{}', { status }))
    return { data: { accessToken: 'token', sessionId: 'sid', session: { user_id: 'account' } }, env: { S3_WORKFLOW_SERVICE: { backup } } }
  }
  it('reserves only migrated dates through the coordinator', async () => {
    vi.mocked(drive.migrateMdToTxt).mockResolvedValue(['2026-01-01'])
    const ctx = context()
    const res = await onRequestPost(ctx as any)
    expect(await res.json()).toEqual({ migrated: 1, s3Resyncing: true })
    expect(ctx.env.S3_WORKFLOW_SERVICE.backup).toHaveBeenCalledWith(expect.objectContaining({ operation: { kind: 'start', dates: ['2026-01-01'] } }))
  })
  it.each([400, 409, 503])('preserves migration success when backup cannot start (%i)', async status => {
    vi.mocked(drive.migrateMdToTxt).mockResolvedValue(['2026-01-01'])
    expect(await (await onRequestPost(context(status) as any)).json()).toEqual({ migrated: 1, s3Resyncing: false })
  })
  it('skips backup when there were no migrated dates', async () => {
    vi.mocked(drive.migrateMdToTxt).mockResolvedValue([])
    const ctx = context()
    expect(await (await onRequestPost(ctx as any)).json()).toEqual({ migrated: 0, s3Resyncing: false })
    expect(ctx.env.S3_WORKFLOW_SERVICE.backup).not.toHaveBeenCalled()
  })
  it('requires a session', async () => {
    expect((await onRequestPost({ data: {} } as any)).status).toBe(401)
  })
  it('reports migration failures', async () => {
    vi.mocked(drive.migrateMdToTxt).mockRejectedValueOnce(new Error('failed'))
    expect((await onRequestPost(context() as any)).status).toBe(500)
  })
})
