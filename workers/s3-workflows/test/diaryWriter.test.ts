import { createSession, getSession, invalidateSession } from '../../../functions/_shared/session'
import { env, createExecutionContext, runInDurableObject } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DriveFileMeta } from '../../../functions/_shared/drive'
import * as drive from '../../../functions/_shared/drive'
import type { DiaryMutationInput } from '../../../functions/_shared/diaryWriter'
import type { DiaryWriter } from '../src/diaryWriter'
import type { WorkflowEnv } from '../src/types'

vi.mock('../../../functions/_shared/drive', async original => ({
  ...await original<typeof import('../../../functions/_shared/drive')>(),
  ensureFolder: vi.fn(), findEntryMeta: vi.fn(), getDiaryFileMeta: vi.fn(),
  getEntryContent: vi.fn(), getEntryMeta: vi.fn(), saveEntry: vi.fn(), generateFileId: vi.fn(), trashEntry: vi.fn(),
}))
const { default: Service } = await import('../src/index')

const date = '2026-10-31'
const files = new Map<string, { meta: DriveFileMeta; content: string }>()
let sequence = 0
let active = 0
let maxActive = 0

beforeEach(() => {
  vi.clearAllMocks()
  files.clear()
  active = maxActive = 0
  vi.mocked(drive.ensureFolder).mockImplementation(async (_token, _id, session) => {
    session.folder_id ??= `folder-${session.google_sub}`
    return session.folder_id
  })
  // Deliberately model a lagging filename index. The durable direct-ID mapping
  // must protect a second first-save even before Drive's listing catches up.
  vi.mocked(drive.findEntryMeta).mockResolvedValue(null)
  vi.mocked(drive.getEntryMeta).mockImplementation(async (_token, id) => ({ id, name: 'linger_diary', mimeType: 'application/vnd.google-apps.folder' }))
  vi.mocked(drive.getDiaryFileMeta).mockImplementation(async (_token, _id, session, _env, id) => {
    const record = files.get(id)
    if (!record || record.meta.trashed || record.meta.parents?.[0] !== session.folder_id) throw new drive.DriveError(404, 'not_found')
    return { ...record.meta }
  })
  vi.mocked(drive.getEntryContent).mockImplementation(async (_token, id) => ({ date, content: files.get(id)!.content }))
  vi.mocked(drive.generateFileId).mockImplementation(async () => `generated-file-${++sequence}`)
  vi.mocked(drive.saveEntry).mockImplementation(async (_token, entry, folderId, fileId, _condition, createId) => {
    active++
    maxActive = Math.max(maxActive, active)
    await new Promise(resolve => setTimeout(resolve, 10))
    active--
    const id = fileId ?? createId!
    if (!fileId && files.has(id)) throw new drive.DriveError(409, 'already exists')
    const meta = { id, name: `diary-${entry.date}.txt`, version: String(Number(files.get(id)?.meta.version ?? 0) + 1), parents: [folderId!], mimeType: 'text/plain' }
    files.set(id, { meta, content: entry.content })
    return { ...meta }
  })
  vi.mocked(drive.trashEntry).mockImplementation(async (_token, id) => { files.get(id)!.meta.trashed = true })
})
afterEach(() => vi.restoreAllMocks())

async function account() {
  const accountKey = crypto.randomUUID()
  const workflowEnv = env as WorkflowEnv
  const auth = { accountKey, sessionId: `session-${accountKey}` }
  await createSession(auth.sessionId, { google_sub: accountKey, access_token: 'test', refresh_token: 'test', expires_at: Date.now() + 3_600_000 }, workflowEnv)
  await workflowEnv.S3_SYNC_INDEX.getByName(accountKey).setBackupEnabled(false)
  const service = new Service(createExecutionContext(), workflowEnv)
  const input = (content: string, options: object = {}): DiaryMutationInput => ({ ...auth, date, method: 'POST', body: JSON.stringify({ content, baseVersion: null, ...options }) })
  return { auth, service, input, writer: workflowEnv.DIARY_WRITER.getByName(accountKey) }
}

describe('account-scoped diary mutations', () => {
  it('allows one of two concurrent first saves and retains one Drive file despite listing lag', async () => {
    const { service, input } = await account()
    const responses = await Promise.all(['device A', 'device B'].map(content => service.mutateDiaryEntry(input(content))))
    expect(responses.map(r => r.status).sort()).toEqual([200, 409])
    expect(files.size).toBe(1)
    expect(drive.saveEntry).toHaveBeenCalledOnce()
    expect([...files.values()][0].content).toBe(responses[0].status === 200 ? 'device A' : 'device B')
  })

  it('serializes updates from separate login sessions and returns the winning content as a conflict', async () => {
    const { auth, service, input } = await account()
    const first = await service.mutateDiaryEntry(input('original'))
    const meta = await first.json() as DriveFileMeta
    const otherSession = `other-${auth.sessionId}`
    await createSession(otherSession, (await getSession(auth.sessionId, env))!, env)
    const base = { fileId: meta.id, baseVersion: meta.version, baseContent: 'original' }
    const responses = await Promise.all([
      service.mutateDiaryEntry(input('device A', base)),
      service.mutateDiaryEntry({ ...input('device B', base), sessionId: otherSession }),
    ])
    expect(responses.map(r => r.status).sort()).toEqual([200, 409])
    const winningContent = responses[0].status === 200 ? 'device A' : 'device B'
    expect(await responses.find(response => response.status === 409)!.json()).toMatchObject({ conflict: { entry: { content: winningContent } } })
    expect(maxActive).toBe(1)
  })

  it('does not serialize unrelated accounts behind each other', async () => {
    const a = await account()
    const b = await account()
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const save = vi.mocked(drive.saveEntry).getMockImplementation()!
    vi.mocked(drive.saveEntry).mockImplementationOnce(async (...args) => { enter(); await gate; return save(...args) })
    const first = a.service.mutateDiaryEntry(a.input('A'))
    await entered
    try {
      expect((await b.service.mutateDiaryEntry(b.input('B'))).status).toBe(200)
    } finally { release() }
    expect((await first).status).toBe(200)
    expect(files.size).toBe(2)
  })

  it('cancels a stale delete after an update, and moves a matching delete to the trash', async () => {
    const { auth, service, input } = await account()
    const first = await service.mutateDiaryEntry(input('original'))
    const meta = await first.json() as DriveFileMeta
    await service.mutateDiaryEntry(input('new content', { fileId: meta.id, baseVersion: meta.version }))
    const deletion: DiaryMutationInput = { ...auth, date, method: 'DELETE', fileId: meta.id, baseVersion: '1' }
    expect((await service.mutateDiaryEntry(deletion)).status).toBe(409)
    expect(drive.trashEntry).not.toHaveBeenCalled()
    expect((await service.mutateDiaryEntry({ ...deletion, baseVersion: '2' })).status).toBe(204)
    expect(files.get(meta.id)?.meta.trashed).toBe(true)
  })

  it('does not apply an old delete to a recreated file with the same initial version', async () => {
    const { auth, service, input } = await account()
    const meta = await (await service.mutateDiaryEntry(input('original'))).json() as DriveFileMeta
    const deletion: DiaryMutationInput = { ...auth, date, method: 'DELETE', fileId: meta.id, baseVersion: meta.version }
    expect((await service.mutateDiaryEntry(deletion)).status).toBe(204)
    const recreated = await service.mutateDiaryEntry(input('recreated'))
    expect(recreated.status).toBe(200)
    const newMeta = await recreated.json() as DriveFileMeta
    expect(newMeta.id).not.toBe(meta.id)
    expect(newMeta.version).toBe(meta.version)
    expect((await service.mutateDiaryEntry(deletion)).status).toBe(409)
    expect(files.get(newMeta.id)?.meta.trashed).not.toBe(true)
  })

  it('allows only one of a concurrent save and delete against the same version', async () => {
    const { auth, service, input } = await account()
    const meta = await (await service.mutateDiaryEntry(input('original'))).json() as DriveFileMeta
    const responses = await Promise.all([
      service.mutateDiaryEntry(input('new content', { fileId: meta.id, baseVersion: meta.version })),
      service.mutateDiaryEntry({ ...auth, date, method: 'DELETE', fileId: meta.id, baseVersion: meta.version }),
    ])
    if (responses[0].status === 200) {
      expect(responses[1].status).toBe(409)
      expect(files.get(meta.id)?.content).toBe('new content')
      expect(drive.trashEntry).not.toHaveBeenCalled()
    } else {
      expect(responses.map(response => response.status)).toEqual([409, 204])
      expect(files.get(meta.id)?.meta.trashed).toBe(true)
    }
  })

  it('rejects deletion without a file identity and version', async () => {
    const { auth, service, input } = await account()
    await service.mutateDiaryEntry(input('retained'))
    expect((await service.mutateDiaryEntry({ ...auth, date, method: 'DELETE' })).status).toBe(428)
    expect(drive.trashEntry).not.toHaveBeenCalled()
  })

  it('reuses a persisted creation ID after a write commits but its response is lost', async () => {
    const { service, input, writer } = await account()
    const save = vi.mocked(drive.saveEntry).getMockImplementation()!
    vi.mocked(drive.saveEntry).mockImplementationOnce(async (...args) => {
      await save(...args)
      throw new TypeError('response lost')
    })
    expect((await service.mutateDiaryEntry(input('retained'))).status).toBe(500)
    const reserved = await runInDurableObject(writer, async (_instance: DiaryWriter, state) => state.storage.get<{ id: string; folderId: string }>(`create:${date}`))
    expect(reserved).toBeTruthy()
    expect((await service.mutateDiaryEntry(input('retained'))).status).toBe(200)
    expect(files.size).toBe(1)
    expect(drive.generateFileId).toHaveBeenCalledOnce()
    expect([...files.keys()]).toEqual([reserved!.id])
  })

  it('rejects an account mismatch before accessing Drive', async () => {
    const { service, input } = await account()
    await expect(service.mutateDiaryEntry({ ...input('secret'), accountKey: 'another-account' })).rejects.toThrow('Unauthorized')
    expect(drive.saveEntry).not.toHaveBeenCalled()
  })

  it('recovers when the folder persisted by an earlier write was trashed in Drive', async () => {
    const { service, input, writer } = await account()
    await service.mutateDiaryEntry(input('old entry'))
    vi.mocked(drive.getEntryMeta).mockResolvedValueOnce({ id: 'old-folder', name: 'linger_diary', mimeType: 'application/vnd.google-apps.folder', trashed: true })
    vi.mocked(drive.ensureFolder).mockImplementationOnce(async (_token, _id, session) => {
      expect(session.folder_id).toBeUndefined()
      session.folder_id = 'replacement-folder'
      return session.folder_id
    })
    const response = await service.mutateDiaryEntry({ ...input('new entry'), date: '2026-11-01' })
    expect(response.status).toBe(200)
    expect(await runInDurableObject(writer, async (_instance: DiaryWriter, state) => state.storage.get('folder'))).toBe('replacement-folder')
    const meta = await response.json() as DriveFileMeta
    expect(files.get(meta.id)?.meta.parents).toEqual(['replacement-folder'])
  })

  it('rechecks a revoked session after waiting behind another device write', async () => {
    const { auth, service, input } = await account()
    const otherSession = `other-${auth.sessionId}`
    await createSession(otherSession, (await getSession(auth.sessionId, env))!, env)
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const save = vi.mocked(drive.saveEntry).getMockImplementation()!
    vi.mocked(drive.saveEntry).mockImplementationOnce(async (...args) => { enter(); await gate; return save(...args) })
    const first = service.mutateDiaryEntry(input('first device'))
    await entered
    const queued = service.mutateDiaryEntry({ ...input('revoked device'), sessionId: otherSession })
    const rejected = expect(queued).rejects.toThrow('Unauthorized')
    await invalidateSession(otherSession, undefined, env)
    release()
    expect((await first).status).toBe(200)
    await rejected
    expect(drive.saveEntry).toHaveBeenCalledOnce()
  })
})
