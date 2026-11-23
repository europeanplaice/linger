import { getSession, invalidateSession, saveSession } from '../../../functions/_shared/session'
import { env, createExecutionContext, runInDurableObject } from 'cloudflare:test'
import { exports as bindings } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DriveFileMeta } from '../../../functions/_shared/drive'
import * as drive from '../../../functions/_shared/drive'
import type { DiaryMutationInput, DiaryUploadInput } from '../../../functions/_shared/diaryWriter'
import { DIARY_UPLOAD_URL } from '../../../functions/_shared/diaryWriter'
import { mirrorCurrentEntry } from '../../../functions/_shared/s3Settings'
import type { DiaryWriter } from '../src/diaryWriter'
import type { S3SyncIndex } from '../src/syncIndex'
import type { WorkflowEnv } from '../src/types'
import { openVaultValue, sealVaultValue, vaultLookupKey } from '../../../functions/_shared/vaultCrypto'
import { createTestSession, testSession, vaultKey } from './auth'

vi.mock('../../../functions/_shared/drive', async original => ({
  ...await original<typeof import('../../../functions/_shared/drive')>(),
  ensureFolder: vi.fn(), findEntryMeta: vi.fn(), getDiaryFileMeta: vi.fn(),
  getEntryContent: vi.fn(), getEntryMeta: vi.fn(), inspectDriveFolder: vi.fn(), listDriveFolders: vi.fn(), saveEntry: vi.fn(), generateFileId: vi.fn(), trashEntry: vi.fn(),
  beginEntryUpload: vi.fn(), entryUploadStatus: vi.fn(), cancelEntryUpload: vi.fn(),
}))
vi.mock('../../../functions/_shared/s3Settings', async original => ({
  ...await original<typeof import('../../../functions/_shared/s3Settings')>(),
  mirrorEntrySave: vi.fn(async () => {}),
  mirrorEntryDelete: vi.fn(async () => {}),
  mirrorCurrentEntry: vi.fn(async () => {}),
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
  vi.mocked(drive.inspectDriveFolder).mockImplementation(async (token, id) => {
    const meta = await drive.getEntryMeta(token, id)
    if (meta.mimeType !== 'application/vnd.google-apps.folder' || meta.trashed) throw new drive.DriveError(400, 'Selected item is not an available Drive folder')
    return { id, name: meta.name, canAddChildren: true, entryCount: 1, firstEntryDate: date, lastEntryDate: date }
  })
  vi.mocked(drive.listDriveFolders).mockResolvedValue([])
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
  const auth = {
    accountKey,
    sessionId: `session-${accountKey}`,
    vaultKey: vaultKey(),
    accessToken: 'test-access-token',
    expiresAt: Date.now() + 3_600_000,
    idToken: 'test-id-token',
  }
  await createTestSession(auth.sessionId, testSession(accountKey, { vault_key: auth.vaultKey, access_token: 'test' }), workflowEnv)
  await workflowEnv.S3_SYNC_INDEX.getByName(accountKey).setBackupEnabled(false)
  const service = new Service(createExecutionContext(), workflowEnv)
  const input = (content: string, options: object = {}): DiaryMutationInput => ({ ...auth, date, method: 'POST', body: JSON.stringify({ content, baseVersion: null, ...options }) })
  return { auth, service, input, writer: workflowEnv.DIARY_WRITER.getByName(accountKey) }
}

describe('account-scoped diary mutations', () => {
  it('resolves backup metadata through the writer ID while Drive filename search still lags', async () => {
    const { auth, service, input } = await account()
    const saved = await (await service.mutateDiaryEntry(input('new diary'))).json() as DriveFileMeta
    vi.mocked(drive.findEntryMeta).mockClear()
    expect(await service.getDiaryEntryMeta({ ...auth, date })).toEqual(saved)
    expect(drive.findEntryMeta).not.toHaveBeenCalled()
  })

  it('rebinds to a renamed visible folder, clears folder caches and keeps that folder on later discovery', async () => {
    const { auth, service, writer } = await account()
    const renamed = { id: 'renamed-folder', name: 'My old journal' }
    vi.mocked(drive.listDriveFolders).mockResolvedValue([renamed, { id: 'empty-canonical', name: 'linger_diary' }])
    const session = (await getSession(auth.sessionId, env, auth.vaultKey))!
    session.folder_id = 'old-folder'
    session.changes_start_page_token = 'old-folder-change-token'
    session.s3_settings_file_id = 'old-settings'
    session.s3_status_file_id = 'old-status'
    session.s3_settings_negative_cache_at = Date.now()
    session.s3_status_negative_cache_at = Date.now()
    await saveSession(auth.sessionId, session, env)

    const fileCache = await sealVaultValue(auth.vaultKey, auth.accountKey, `diary-writer:file:${date}`, 'old-file-id')
    const createCache = await sealVaultValue(auth.vaultKey, auth.accountKey, `diary-writer:create:${date}`, { id: 'old-create-id', folderId: 'old-folder' })
    await runInDurableObject(writer, (_instance: DiaryWriter, state) => state.storage.put({ [`file:${date}`]: fileCache, [`create:${date}`]: createCache }))
    const index = env.S3_SYNC_INDEX.getByName(auth.accountKey)
    await index.updateProtectedEntry(auth, date, 'pending', '7', new Date().toISOString())

    expect(await service.selectDiaryFolder({ ...auth, folderId: renamed.id })).toBe(renamed.id)
    const stored = (await runInDurableObject(writer, async (_instance: DiaryWriter, state) => ({
      folder: await state.storage.get<string>('folder'),
      file: await state.storage.get<string>(`file:${date}`),
      create: await state.storage.get<string>(`create:${date}`),
    })))
    expect(await openVaultValue<string>(auth.vaultKey, auth.accountKey, 'diary-writer:folder', stored.folder!)).toBe(renamed.id)
    expect(stored.file).toBeUndefined()
    expect(stored.create).toBeUndefined()
    expect(await index.getProtectedEntry(auth, date)).toBeNull()
    const reconciled = (await getSession(auth.sessionId, env, auth.vaultKey))!
    expect(reconciled.folder_id).toBe(renamed.id)
    expect(reconciled.changes_start_page_token).toBeUndefined()
    expect(reconciled.s3_settings_file_id).toBeUndefined()
    expect(reconciled.s3_status_file_id).toBeUndefined()
    expect(reconciled.s3_settings_negative_cache_at).toBeUndefined()
    expect(reconciled.s3_status_negative_cache_at).toBeUndefined()

    expect(await service.ensureDiaryFolder(auth)).toBe(renamed.id)
    expect(drive.ensureFolder).toHaveBeenLastCalledWith('test-access-token', auth.sessionId, expect.objectContaining({ folder_id: renamed.id }), expect.anything(), {
      withinCoordinator: true,
      discoverByName: false,
    })
  })

  it('rejects a folder id that is not visible to the authenticated Google account', async () => {
    const { auth, service } = await account()
    vi.mocked(drive.listDriveFolders).mockResolvedValue([{ id: 'visible-folder', name: 'Diary' }])
    await expect(service.selectDiaryFolder({ ...auth, folderId: 'another-account-folder' })).rejects.toThrow('not available')
  })

  it('rejects visible IDs that resolve to a file or a trashed folder', async () => {
    const { auth, service } = await account()
    vi.mocked(drive.listDriveFolders).mockResolvedValue([{ id: 'bad-folder', name: 'Diary' }])
    vi.mocked(drive.getEntryMeta)
      .mockResolvedValueOnce({ id: 'bad-folder', name: 'diary.txt', mimeType: 'text/plain' })
      .mockResolvedValueOnce({ id: 'bad-folder', name: 'Diary', mimeType: 'application/vnd.google-apps.folder', trashed: true })
    await expect(service.selectDiaryFolder({ ...auth, folderId: 'bad-folder' })).rejects.toThrow('available Drive folder')
    await expect(service.selectDiaryFolder({ ...auth, folderId: 'bad-folder' })).rejects.toThrow('available Drive folder')
  })


  it('requires empty-folder confirmation and preserves the current pointer and backup index on rejection', async () => {
    const { auth, service } = await account()
    const previous = await service.ensureDiaryFolder(auth)
    const index = env.S3_SYNC_INDEX.getByName(auth.accountKey)
    await index.updateProtectedEntry(auth, date, 'pending', '7', new Date().toISOString())
    vi.mocked(drive.listDriveFolders).mockResolvedValue([{ id: 'empty', name: 'Empty' }])
    vi.mocked(drive.inspectDriveFolder).mockResolvedValue({ id: 'empty', name: 'Empty', canAddChildren: true, entryCount: 0, firstEntryDate: null, lastEntryDate: null })
    await expect(service.selectDiaryFolder({ ...auth, folderId: 'empty' })).rejects.toThrow('FOLDER_EMPTY')
    expect((await getSession(auth.sessionId, env, auth.vaultKey))!.folder_id).toBe(previous)
    expect(await index.getProtectedEntry(auth, date)).not.toBeNull()
    expect(await service.selectDiaryFolder({ ...auth, folderId: 'empty', allowEmpty: true })).toBe('empty')
    expect((await getSession(auth.sessionId, env, auth.vaultKey))!.folder_id).toBe('empty')
  })

  it('rechecks write permissions before changing any folder or backup state', async () => {
    const { auth, service } = await account()
    const previous = await service.ensureDiaryFolder(auth)
    vi.mocked(drive.listDriveFolders).mockResolvedValue([{ id: 'readonly', name: 'Read only' }])
    vi.mocked(drive.inspectDriveFolder).mockResolvedValue({ id: 'readonly', name: 'Read only', canAddChildren: false, entryCount: 1, firstEntryDate: date, lastEntryDate: date })
    await expect(service.selectDiaryFolder({ ...auth, folderId: 'readonly', allowEmpty: true })).rejects.toThrow('FOLDER_READ_ONLY')
    expect((await getSession(auth.sessionId, env, auth.vaultKey))!.folder_id).toBe(previous)
  })

  it('rejects a folder selection with credentials for a different account', async () => {
    const { auth, service } = await account()
    await expect(service.selectDiaryFolder({ ...auth, accountKey: 'other-account', folderId: 'visible-folder' })).rejects.toThrow()
    expect(drive.listDriveFolders).not.toHaveBeenCalled()
  })

  it('clears folder-scoped S3 caches when a session adopts the account folder', async () => {
    const { auth, service } = await account()
    const accountFolder = await service.ensureDiaryFolder(auth)
    const session = (await getSession(auth.sessionId, env, auth.vaultKey))!
    session.folder_id = 'old-device-folder'
    session.s3_settings_file_id = 'old-settings-file'
    session.s3_status_file_id = 'old-status-file'
    session.s3_settings_negative_cache_at = Date.now()
    session.s3_status_negative_cache_at = Date.now()
    await saveSession(auth.sessionId, session, env)

    expect(await service.ensureDiaryFolder(auth)).toBe(accountFolder)
    const reconciled = (await getSession(auth.sessionId, env, auth.vaultKey))!
    expect(reconciled.folder_id).toBe(accountFolder)
    expect(reconciled.s3_settings_file_id).toBeUndefined()
    expect(reconciled.s3_status_file_id).toBeUndefined()
    expect(reconciled.s3_settings_negative_cache_at).toBeUndefined()
    expect(reconciled.s3_status_negative_cache_at).toBeUndefined()
  })

  it('reconciles a second device session to the account folder pointer', async () => {
    const { auth, service, writer } = await account()
    const firstSession = (await getSession(auth.sessionId, env, auth.vaultKey))!
    firstSession.folder_id = 'legacy-folder-a'
    await saveSession(auth.sessionId, firstSession, env)
    const firstFolder = await service.ensureDiaryFolder(auth)
    const secondSessionId = `other-${auth.sessionId}`
    await createTestSession(secondSessionId, { ...firstSession, folder_id: 'legacy-folder-b' }, env)

    const secondFolder = await service.ensureDiaryFolder({ ...auth, sessionId: secondSessionId })

    expect(firstFolder).toBe('legacy-folder-a')
    expect(secondFolder).toBe(firstFolder)
    expect((await getSession(secondSessionId, env, auth.vaultKey))?.folder_id).toBe(firstFolder)
    const folderEnvelope = await runInDurableObject(writer, async (_instance: DiaryWriter, state) => state.storage.get<string>('folder'))
    expect(folderEnvelope).toMatch(/^v1\./)
    expect(await openVaultValue<string>(auth.vaultKey, auth.accountKey, 'diary-writer:folder', folderEnvelope!)).toBe(firstFolder)
  })

  it('drops a legacy object-shaped create reservation and creates an encrypted replacement', async () => {
    const { auth, service, input, writer } = await account()
    await runInDurableObject(writer, (_instance: DiaryWriter, state) =>
      state.storage.put(`create:${date}`, { id: 'legacy-drive-file-id', folderId: 'legacy-folder-id' }),
    )

    expect((await service.mutateDiaryEntry(input('new entry'))).status).toBe(200)
    const reservation = await runInDurableObject(writer, async (_instance: DiaryWriter, state) =>
      [...(await state.storage.list<string>({ prefix: 'file:v2:' })).values()][0],
    )
    expect(reservation).toMatch(/^v1\./)
    expect(reservation).not.toContain('legacy-drive-file-id')
    expect(reservation).not.toContain(auth.vaultKey)
  })

  it('rejects a tampered versioned cache instead of treating it as a Drive ID', async () => {
    const { auth, service, writer } = await account()
    await runInDurableObject(writer, (_instance: DiaryWriter, state) => state.storage.put('folder', 'v1.invalid.invalid'))

    await expect(service.ensureDiaryFolder(auth)).rejects.toThrow()
    expect(drive.ensureFolder).not.toHaveBeenCalled()
  })

  it('allows one of two concurrent first saves and retains one Drive file despite listing lag', async () => {
    const { auth, service, input, writer } = await account()
    const responses = await Promise.all(['device A', 'device B'].map(content => service.mutateDiaryEntry(input(content))))
    expect(responses.map(r => r.status).sort()).toEqual([200, 409])
    expect(files.size).toBe(1)
    expect(drive.saveEntry).toHaveBeenCalledOnce()
    expect([...files.values()][0].content).toBe(responses[0].status === 200 ? 'device A' : 'device B')
    const saved = await responses.find(response => response.status === 200)!.json() as DriveFileMeta
    const stored = await runInDurableObject(writer, async (_instance: DiaryWriter, state) =>
      Object.fromEntries(await state.storage.list()),
    )
    const serialized = JSON.stringify(stored)
    expect(serialized).not.toContain(date)
    expect(serialized).not.toContain(auth.vaultKey)
    expect(serialized).not.toContain(saved.id)
    expect(serialized).not.toContain('folder-' + auth.accountKey)
    expect(Object.values(stored).every(value => typeof value === 'string' && value.startsWith('v1.'))).toBe(true)
  })

  it('moves an existing encrypted reservation to a private lookup key without losing its Drive ID', async () => {
    const { auth, service, input, writer } = await account()
    const folderId = await service.ensureDiaryFolder(auth)
    const legacy = await sealVaultValue(auth.vaultKey, auth.accountKey, `diary-writer:create:${date}`, { id: 'reserved-id', folderId })
    await runInDurableObject(writer, (_instance: DiaryWriter, state) => state.storage.put(`create:${date}`, legacy))

    expect((await service.mutateDiaryEntry(input('entry'))).status).toBe(200)
    expect(drive.generateFileId).not.toHaveBeenCalled()
    expect(files.has('reserved-id')).toBe(true)
    const stored = await runInDurableObject(writer, async (_instance: DiaryWriter, state) => Object.fromEntries(await state.storage.list()))
    expect(JSON.stringify(stored)).not.toContain(date)
  })

  it('preserves an object-shaped legacy reservation when retrying a create', async () => {
    const { auth, service, input, writer } = await account()
    const folderId = await service.ensureDiaryFolder(auth)
    await runInDurableObject(writer, (_instance: DiaryWriter, state) =>
      state.storage.put(`create:${date}`, { id: 'legacy-reserved-id', folderId }),
    )
    expect((await service.mutateDiaryEntry(input('entry'))).status).toBe(200)
    expect(drive.generateFileId).not.toHaveBeenCalled()
    expect(files.has('legacy-reserved-id')).toBe(true)
    const stored = await runInDurableObject(writer, async (_instance: DiaryWriter, state) => Object.fromEntries(await state.storage.list()))
    expect(JSON.stringify(stored)).not.toContain(date)
    expect(JSON.stringify(stored)).not.toContain('legacy-reserved-id')
  })

  it('retains a legacy reservation if a partially migrated record is corrupted', async () => {
    const { auth, service, writer } = await account()
    const folderId = await service.ensureDiaryFolder(auth)
    const old = await sealVaultValue(auth.vaultKey, auth.accountKey, `diary-writer:create:${date}`, { id: 'reserved-id', folderId })
    const digest = await vaultLookupKey(auth.vaultKey, auth.accountKey, 'diary-writer-date', date)
    await runInDurableObject(writer, (_instance: DiaryWriter, state) => state.storage.put({ [`create:${date}`]: old, [`create:v2:${digest}`]: 'v1.invalid.invalid' }))
    await expect(service.ensureDiaryFolder(auth)).rejects.toThrow()
    const remaining = await runInDurableObject(writer, (_instance: DiaryWriter, state) => state.storage.get(`create:${date}`))
    expect(remaining).toBe(old)
    expect(drive.generateFileId).not.toHaveBeenCalled()
  })

  it('migrates every legacy date key on an authenticated folder request', async () => {
    const { auth, service, writer } = await account()
    const otherDate = '2002-03-04'
    const oldFile = await sealVaultValue(auth.vaultKey, auth.accountKey, `diary-writer:file:${date}`, 'old-file')
    const oldCreate = await sealVaultValue(auth.vaultKey, auth.accountKey, `diary-writer:create:${otherDate}`, { id: 'reserved', folderId: 'old-folder' })
    await runInDurableObject(writer, (_instance: DiaryWriter, state) => state.storage.put({ [`file:${date}`]: oldFile, [`create:${otherDate}`]: oldCreate }))

    await service.ensureDiaryFolder(auth)
    const stored = await runInDurableObject(writer, async (_instance: DiaryWriter, state) => Object.fromEntries(await state.storage.list()))
    const entries = Object.entries(stored)
    expect(entries.some(([key]) => key.startsWith('file:v2:'))).toBe(true)
    expect(entries.some(([key]) => key.startsWith('create:v2:'))).toBe(true)
    expect(JSON.stringify(stored)).not.toContain(date)
    expect(JSON.stringify(stored)).not.toContain(otherDate)
    const [key, envelope] = entries.find(([name]) => name.startsWith('create:v2:'))!
    expect(await openVaultValue(auth.vaultKey, auth.accountKey, `diary-writer:${key}`, envelope as string)).toEqual({ id: 'reserved', folderId: 'old-folder' })
  })

  it('keeps diary saves available if an unrelated legacy sync job cannot migrate', async () => {
    const { auth, service, input } = await account()
    const index = env.S3_SYNC_INDEX.getByName(auth.accountKey)
    await runInDurableObject(index, (instance: S3SyncIndex, state) => {
      instance.startJob('legacy-request', 'legacy-job', 'legacy-workflow', true, new Date().toISOString())
      state.storage.sql.exec('UPDATE jobs SET failed_dates = ? WHERE job_id = ?', 'invalid-legacy-data', 'legacy-job')
      instance.finishJob('legacy-job', new Date().toISOString())
    })
    expect((await service.mutateDiaryEntry(input('entry'))).status).toBe(200)
    expect(files.size).toBe(1)
    await runInDurableObject(index, (_instance: S3SyncIndex, state) => {
      expect(state.storage.sql.exec<{ failed_dates: string }>('SELECT failed_dates FROM jobs WHERE job_id = ?', 'legacy-job').one().failed_dates).toBe('invalid-legacy-data')
    })
  })

  it('migrates old sync dates when the user opens their diary', async () => {
    const { auth, service } = await account()
    const index = env.S3_SYNC_INDEX.getByName(auth.accountKey)
    await runInDurableObject(index, (instance: S3SyncIndex, state) => {
      state.storage.sql.exec("INSERT INTO entries (date, drive_version, synced_version, state, updated_at) VALUES (?, '1', '1', 'synced', ?)", date, new Date().toISOString())
      instance.startJob('legacy-request', 'legacy-job', 'legacy-workflow', true, new Date().toISOString())
      state.storage.sql.exec('UPDATE jobs SET failed_dates = ? WHERE job_id = ?', JSON.stringify([date]), 'legacy-job')
      instance.finishJob('legacy-job', new Date().toISOString())
    })
    await service.ensureDiaryFolder(auth)
    expect(await index.getProtectedEntry(auth, date)).toMatchObject({ date, syncedVersion: '1' })
    expect(await index.getProtectedJob(auth, 'legacy-job')).toMatchObject({ failedDates: [date] })
    await runInDurableObject(index, (_instance: S3SyncIndex, state) => {
      const rows = { entries: state.storage.sql.exec('SELECT * FROM entries').toArray(), jobs: state.storage.sql.exec('SELECT * FROM jobs').toArray(), dates: state.storage.sql.exec('SELECT * FROM protected_job_dates').toArray() }
      expect(rows.entries).toEqual([])
      expect(JSON.stringify(rows)).not.toContain(date)
    })
  })

  it('rejects an incorrect vault key before changing legacy sync records', async () => {
    const { auth, service } = await account()
    const index = env.S3_SYNC_INDEX.getByName(auth.accountKey)
    await runInDurableObject(index, (_instance: S3SyncIndex, state) => {
      state.storage.sql.exec("INSERT INTO entries (date, state, updated_at) VALUES (?, 'pending', ?)", date, new Date().toISOString())
    })
    await expect(service.ensureDiaryFolder({ ...auth, vaultKey: vaultKey() })).rejects.toThrow(/unauthorized/i)
    await runInDurableObject(index, (_instance: S3SyncIndex, state) => {
      expect(state.storage.sql.exec('SELECT date FROM entries').toArray()).toEqual([{ date }])
      expect(state.storage.sql.exec('SELECT * FROM protected_entries').toArray()).toEqual([])
    })
  })

  it('serializes updates from separate login sessions and returns the winning content as a conflict', async () => {
    const { auth, service, input } = await account()
    const first = await service.mutateDiaryEntry(input('original'))
    const meta = await first.json() as DriveFileMeta
    const otherSession = `other-${auth.sessionId}`
    await createTestSession(otherSession, (await getSession(auth.sessionId, env, auth.vaultKey))!, env)
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
    const { auth, service, input, writer } = await account()
    const save = vi.mocked(drive.saveEntry).getMockImplementation()!
    vi.mocked(drive.saveEntry).mockImplementationOnce(async (...args) => {
      await save(...args)
      throw new TypeError('response lost')
    })
    expect((await service.mutateDiaryEntry(input('retained'))).status).toBe(500)
    const [reservedKey, reserved] = await runInDurableObject(writer, async (_instance: DiaryWriter, state) => [...(await state.storage.list<string>({ prefix: 'create:v2:' })).entries()][0])
    expect(reserved).toMatch(/^v1\./)
    const reservation = await openVaultValue<{ id: string; folderId: string }>(auth.vaultKey, auth.accountKey, `diary-writer:${reservedKey}`, reserved!)
    expect((await service.mutateDiaryEntry(input('retained'))).status).toBe(200)
    expect(files.size).toBe(1)
    expect(drive.generateFileId).toHaveBeenCalledOnce()
    expect([...files.keys()]).toEqual([reservation.id])
  })

  it('rejects an account mismatch before accessing Drive', async () => {
    const { service, input } = await account()
    await expect(service.mutateDiaryEntry({ ...input('secret'), accountKey: 'another-account' })).rejects.toThrow('Unauthorized')
    expect(drive.saveEntry).not.toHaveBeenCalled()
  })

  it('recovers when the folder persisted by an earlier write was trashed in Drive', async () => {
    const { auth, service, input, writer } = await account()
    await service.mutateDiaryEntry(input('old entry'))
    vi.mocked(drive.getEntryMeta)
      .mockResolvedValueOnce({ id: 'old-folder', name: 'linger_diary', mimeType: 'application/vnd.google-apps.folder', trashed: true })
      .mockResolvedValueOnce({ id: 'old-folder', name: 'linger_diary', mimeType: 'application/vnd.google-apps.folder', trashed: true })
    vi.mocked(drive.ensureFolder).mockImplementationOnce(async (_token, _id, session) => {
      expect(session.folder_id).toBeUndefined()
      session.folder_id = 'replacement-folder'
      return session.folder_id
    })
    const response = await service.mutateDiaryEntry({ ...input('new entry'), date: '2026-11-01' })
    expect(response.status).toBe(200)
    const folderEnvelope = await runInDurableObject(writer, async (_instance: DiaryWriter, state) => state.storage.get<string>('folder'))
    expect(folderEnvelope).toMatch(/^v1\./)
    expect(await openVaultValue<string>(auth.vaultKey, auth.accountKey, 'diary-writer:folder', folderEnvelope!)).toBe('replacement-folder')
    const meta = await response.json() as DriveFileMeta
    expect(files.get(meta.id)?.meta.parents).toEqual(['replacement-folder'])
  })

  it('rechecks a revoked session after waiting behind another device write', async () => {
    const { auth, service, input } = await account()
    const otherSession = `other-${auth.sessionId}`
    await createTestSession(otherSession, (await getSession(auth.sessionId, env, auth.vaultKey))!, env)
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

describe('coordinated direct Drive uploads', () => {
  const uploadUrl = 'https://www.googleapis.com/upload/drive/v3/files?upload_id=provider-session'

  beforeEach(() => {
    vi.mocked(drive.beginEntryUpload).mockResolvedValue(uploadUrl)
    vi.mocked(drive.entryUploadStatus).mockResolvedValue('incomplete')
    vi.mocked(drive.cancelEntryUpload).mockResolvedValue()
  })

  it('keeps the reservation across retries and hands only metadata to S3 after Drive commits', async () => {
    const { auth, service, writer, input } = await account()
    const rpc = (bindings as typeof bindings & { default: Pick<InstanceType<typeof Service>, 'uploadDiaryEntry'> }).default
    const prepare: DiaryUploadInput = {
      ...auth, date, action: 'prepare', operationId: crypto.randomUUID(), origin: 'https://linger.example',
      bytes: 11, baseVersion: null,
    }
    const [first, second] = await Promise.all([
      writer.fetch(DIARY_UPLOAD_URL, { method: 'POST', body: JSON.stringify(prepare) }),
      rpc.uploadDiaryEntry(prepare),
    ])
    expect(await first.json()).toEqual({ uploadUrl })
    expect(second.body).toEqual({ uploadUrl })
    expect(drive.beginEntryUpload).toHaveBeenCalledOnce()
    expect(drive.generateFileId).toHaveBeenCalledOnce()
    expect(drive.saveEntry).not.toHaveBeenCalled()

    const competing = await service.uploadDiaryEntry({ ...prepare, operationId: crypto.randomUUID() })
    expect(competing.status).toBe(429)
    expect((await service.mutateDiaryEntry({ ...input(''), method: 'DELETE' })).status).toBe(429)
    await expect(service.selectDiaryFolder({ ...auth, folderId: 'other-folder' })).rejects.toThrow('in progress')

    const id = await vi.mocked(drive.generateFileId).mock.results[0].value!
    const meta = { id, name: `diary-${date}.txt`, version: '1', mimeType: 'text/plain', parents: [`folder-${auth.accountKey}`] }
    vi.mocked(drive.entryUploadStatus).mockResolvedValue(meta)
    // Model a completed upload whose tab closed before calling complete.
    await service.ensureDiaryFolder(auth)
    expect(mirrorCurrentEntry).toHaveBeenCalledExactlyOnceWith(auth.accessToken, auth.sessionId, expect.anything(), expect.anything(), date)

    const complete: DiaryUploadInput = { ...auth, date, action: 'complete', operationId: prepare.operationId }
    expect((await rpc.uploadDiaryEntry(complete)).body).toEqual({ meta })
    expect(mirrorCurrentEntry).toHaveBeenCalledOnce()
    const metadata = await runInDurableObject(writer, (_instance: DiaryWriter, state) => state.storage.list())
    expect([...metadata.keys()].some(key => key.startsWith('upload:pending:'))).toBe(false)
    expect(JSON.stringify([...metadata])).not.toContain('provider-session')
    expect(drive.getEntryContent).not.toHaveBeenCalled()
  })

  it('cancels an abandoned upload before assigning another session for the same date', async () => {
    const { auth, service, writer } = await account()
    const prepare: DiaryUploadInput = {
      ...auth, date, action: 'prepare', operationId: crypto.randomUUID(), origin: 'https://linger.example',
      bytes: 3, baseVersion: null,
    }
    expect((await service.uploadDiaryEntry(prepare)).status).toBe(200)
    await runInDurableObject(writer, async (_instance: DiaryWriter, state) => {
      const [[key, envelope]] = [...(await state.storage.list<string>({ prefix: 'upload:pending:' })).entries()]
      const purpose = `diary-writer:${key}`
      const upload = await openVaultValue<Record<string, unknown>>(auth.vaultKey, auth.accountKey, purpose, envelope)
      await state.storage.put(key, await sealVaultValue(auth.vaultKey, auth.accountKey, purpose, { ...upload, startedAt: Date.now() - 61_000 }))
    })
    vi.mocked(drive.entryUploadStatus).mockResolvedValueOnce('incomplete').mockResolvedValueOnce('expired')
    expect((await service.uploadDiaryEntry({ ...prepare, operationId: crypto.randomUUID() })).status).toBe(200)
    expect(drive.cancelEntryUpload).toHaveBeenCalledExactlyOnceWith(uploadUrl)
    expect(drive.beginEntryUpload).toHaveBeenCalledTimes(2)
    expect(drive.generateFileId).toHaveBeenCalledOnce()
  })

  it('returns conflict metadata without reading either version of the entry', async () => {
    const { auth, service, input } = await account()
    const meta = await (await service.mutateDiaryEntry(input('previous version'))).json() as DriveFileMeta
    const response = await service.uploadDiaryEntry({
      ...auth, date, action: 'prepare', operationId: crypto.randomUUID(), origin: 'https://linger.example',
      bytes: 3, fileId: meta.id, baseVersion: '0',
    })
    expect(response.status).toBe(409)
    expect(response.body).toEqual({ conflict: meta, canRebase: true })
    expect(drive.getEntryContent).not.toHaveBeenCalled()
    expect(drive.beginEntryUpload).not.toHaveBeenCalled()
  })
})
