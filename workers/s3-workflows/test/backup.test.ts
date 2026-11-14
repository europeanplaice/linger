import { createExecutionContext, env, runInDurableObject } from 'cloudflare:test'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as drive from '../../../functions/_shared/drive'
import * as s3 from '../../../functions/_shared/s3'
import { getSession, invalidateSession } from '../../../functions/_shared/session'
import { createTestSession, testSession, vaultKey } from './auth'
import type { S3SyncIndex } from '../src/syncIndex'

vi.mock('../../../functions/_shared/drive', async original => ({
  ...await original<typeof import('../../../functions/_shared/drive')>(),
  ensureFolder: vi.fn(async () => 'folder'), findJsonFile: vi.fn(), readJsonFile: vi.fn(),
  writeJsonFile: vi.fn(), listEntries: vi.fn(), findCurrentEntryMeta: vi.fn(), getEntryContent: vi.fn(),
  getEntryMeta: vi.fn(async () => ({ id: 'settings', name: 'settings', trashed: false })),
}))
vi.mock('../../../functions/_shared/s3', async original => ({
  ...await original<typeof import('../../../functions/_shared/s3')>(),
  assumeRoleWithWebIdentity: vi.fn(async () => ({ accessKeyId: 'a', secretAccessKey: 's', sessionToken: 't', expiresAt: Date.now() + 100_000 })),
  putObjectIfNewer: vi.fn(), deleteObject: vi.fn(),
}))
const { default: Service } = await import('../src/index')
const config = { enabled: true, roleArn: 'arn:aws:iam::123456789012:role/linger', bucket: 'my-bucket', region: 'us-east-1' }
let files: Map<string, unknown>
const date = '2026-01-01'
beforeEach(() => {
  vi.clearAllMocks()
  files = new Map([['s3_settings.json', config]])
  vi.mocked(drive.findJsonFile).mockImplementation(async (_t, _f, name) => files.has(name) ? name : null)
  vi.mocked(drive.readJsonFile).mockImplementation(async (_t, id) => structuredClone(files.get(id)))
  vi.mocked(drive.writeJsonFile).mockImplementation(async (_t, _f, name, value) => {
    files.set(name, structuredClone(value))
    return { id: name, name }
  })
  vi.mocked(drive.listEntries).mockResolvedValue([{ id: 'file', name: `diary-${date}.txt`, version: '1' }])
  vi.mocked(drive.findCurrentEntryMeta).mockResolvedValue({ id: 'file', name: `diary-${date}.txt`, version: '1' })
  vi.mocked(drive.getEntryContent).mockResolvedValue({ date, content: 'hello' })
  vi.mocked(s3.putObjectIfNewer).mockResolvedValue(undefined)
})
async function account() {
  const accountKey = crypto.randomUUID()
  const auth = { sessionId: `session-${accountKey}`, accountKey, vaultKey: vaultKey(), accessToken: 'access', idToken: 'id-token', expiresAt: Date.now() + 3_600_000 }
  await createTestSession(auth.sessionId, testSession(accountKey, { vault_key: auth.vaultKey }), env)
  return { auth, service: new Service(createExecutionContext(), env), index: env.S3_SYNC_INDEX.getByName(accountKey) }
}
function barrier() {
  let release!: () => void
  let enter!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const entered = new Promise<void>(resolve => { enter = resolve })
  return { gate, entered, enter, release }
}

describe('account backup coordination', () => {
  it('reserves one run when two tabs start together', async () => {
    const { auth, service } = await account()
    const responses = await Promise.all([
      service.backup({ ...auth, operation: { kind: 'start' } }),
      service.backup({ ...auth, operation: { kind: 'start' } }),
    ])
    expect(responses.map(response => response.status).sort()).toEqual([200, 409])
    expect(drive.listEntries).toHaveBeenCalledOnce()
  })

  it('loads progress after taking the queue so simultaneous continuations do not repeat a completed chunk', async () => {
    const { auth, service } = await account()
    await service.backup({ ...auth, operation: { kind: 'start' } })
    const latch = barrier()
    vi.mocked(s3.putObjectIfNewer).mockImplementationOnce(async () => { latch.enter(); await latch.gate })
    const first = service.backup({ ...auth, operation: { kind: 'continue' } })
    await latch.entered
    const second = service.backup({ ...auth, operation: { kind: 'continue' } })
    latch.release()
    expect((await first).status).toBe(200)
    expect(await (await second).json()).toEqual({ ok: true, done: true })
    expect(s3.putObjectIfNewer).toHaveBeenCalledOnce()
  })

  it('orders reconciliation and target changes through the same queue', async () => {
    const { auth, service } = await account()
    const latch = barrier()
    vi.mocked(s3.putObjectIfNewer).mockImplementationOnce(async () => { latch.enter(); await latch.gate })
    const mirror = service.backup({ ...auth, operation: { kind: 'reconcile', date } })
    await latch.entered
    const settings = service.backup({ ...auth, operation: { kind: 'settings', config: { ...config, bucket: 'new-bucket' } } })
    expect(files.get('s3_settings.json')).toEqual(config)
    latch.release()
    expect((await mirror).status).toBe(200)
    expect((await settings).status).toBe(200)
    expect(files.get('s3_settings.json')).toEqual({ ...config, bucket: 'new-bucket' })
  })

  it('revalidates a revoked session after waiting for another tab', async () => {
    const { auth, service } = await account()
    const otherId = `other-${auth.sessionId}`
    await createTestSession(otherId, (await getSession(auth.sessionId, env, auth.vaultKey))!, env)
    const latch = barrier()
    vi.mocked(s3.putObjectIfNewer).mockImplementationOnce(async () => { latch.enter(); await latch.gate })
    const first = service.backup({ ...auth, operation: { kind: 'reconcile', date } })
    await latch.entered
    const second = service.backup({ ...auth, sessionId: otherId, operation: { kind: 'reconcile', date } })
    const rejected = expect(second).rejects.toThrow('Unauthorized')
    await invalidateSession(otherId, undefined, env)
    latch.release()
    await first
    await rejected
    expect(s3.putObjectIfNewer).toHaveBeenCalledOnce()
  })

  it('does not persist dates, text, or request credentials in DO storage', async () => {
    const { auth, service, index } = await account()
    await service.backup({ ...auth, operation: { kind: 'start' } })
    await service.backup({ ...auth, operation: { kind: 'continue' } })
    const stored = await runInDurableObject(index, async (_instance: S3SyncIndex, state) => {
      const sql = state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").toArray()
      return JSON.stringify({ kv: [...await state.storage.list()], sql: sql.map(({ name }) => state.storage.sql.exec(`SELECT * FROM "${name}"`).toArray()) })
    })
    for (const secret of [date, 'hello', auth.accessToken, auth.idToken, auth.vaultKey]) expect(stored).not.toContain(secret)
  })
})
