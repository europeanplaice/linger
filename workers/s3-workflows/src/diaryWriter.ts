import { DurableObject } from 'cloudflare:workers'
import type { DiaryMutationInput, DiaryWriterAuth } from '../../../functions/_shared/diaryWriter'
import { removeDiaryEntry, saveDiaryEntry } from '../../../functions/_shared/entryMutation'
import { DriveConflictError, DriveError, ensureFolder, findEntryMeta, generateFileId, getDiaryFileMeta, getEntryContent, getEntryMeta, saveEntry } from '../../../functions/_shared/drive'
import type { DiaryEntry, DriveFileMeta } from '../../../functions/_shared/drive'
import { getValidSession, jsonResponse } from '../../../functions/_shared/session'
import type { SessionData } from '../../../functions/_shared/session'
import { authorizedSession, mirrorEntryForAuth, deleteEntryForAuth } from './runtime'
import type { WorkflowEnv } from './types'

// One object per Google subject and deployment environment. All sessions/devices
// use this queue, including folder discovery and restores. Do not hold a storage
// transaction or blockConcurrencyWhile across remote Drive requests.
export class DiaryWriter extends DurableObject<WorkflowEnv> {
  private tail: Promise<unknown> = Promise.resolve()
  private queued = 0

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (this.queued >= 32) throw new Error('Diary writer is busy')
    this.queued++
    const run = this.tail.catch(() => {}).then(operation)
    this.tail = run.then(() => {}, () => {})
    try { return await run } finally { this.queued-- }
  }

  private async session(auth: DiaryWriterAuth): Promise<SessionData> {
    // Recheck after waiting in the queue: logout must cancel queued writes.
    const session = await authorizedSession(this.env, auth)
    return getValidSession(auth.sessionId, session, this.env)
  }

  private async folder(auth: DiaryWriterAuth, session: SessionData): Promise<string> {
    const stored = await this.ctx.storage.get<string>('folder')
    if (stored) session.folder_id = stored
    // A persisted pointer must not pin an account to a folder the user has
    // since deleted/trashed in Drive. Preserve transient errors; only absence
    // or a non-folder invalidates the pointer.
    if (session.folder_id) {
      try {
        const meta = await getEntryMeta(session.access_token, session.folder_id)
        if (meta.trashed || meta.mimeType !== 'application/vnd.google-apps.folder') throw new DriveError(404, 'not_found')
      } catch (error) {
        if (!(error instanceof DriveError && error.status === 404)) throw error
        session.folder_id = undefined
        await this.ctx.storage.delete('folder')
      }
    }
    const id = await ensureFolder(session.access_token, auth.sessionId, session, this.env)
    await this.ctx.storage.put('folder', id)
    return id
  }

  async ensureFolder(auth: DiaryWriterAuth): Promise<string> {
    return this.serialize(async () => this.folder(auth, await this.session(auth)))
  }

  async mutate(input: DiaryMutationInput): Promise<Response> {
    return this.serialize(async () => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !['POST', 'DELETE'].includes(input.method)) {
        return jsonResponse({ error: 'Invalid diary mutation' }, 400)
      }
      const session = await this.session(input)
      await this.folder(input, session)
      const token = session.access_token
      const key = `file:${input.date}`
      const reservationKey = `create:${input.date}`
      const findEntry = async (): Promise<DriveFileMeta | null> => {
        const known = await this.ctx.storage.get<string>(key)
        if (known) {
          try { return await getDiaryFileMeta(token, input.sessionId, session, this.env, known, input.date) }
          catch (e) { if (!(e instanceof DriveError && e.status === 404)) throw e }
          await this.ctx.storage.delete(key)
        }
        const meta = await findEntryMeta(token, input.sessionId, session, this.env, input.date)
        if (meta) await this.ctx.storage.put(key, meta.id)
        return meta
      }
      const createEntry = async (entry: DiaryEntry, folderId: string): Promise<DriveFileMeta> => {
        // Persist a Drive-generated ID BEFORE creating. A timeout, lost response,
        // or object restart can retry this ID without creating a second file.
        let reservation = await this.ctx.storage.get<{ id: string; folderId: string }>(reservationKey)
        if (!reservation || reservation.folderId !== folderId) {
          reservation = { id: await generateFileId(token), folderId }
          await this.ctx.storage.put(reservationKey, reservation)
        }
        const { id } = reservation
        let meta: DriveFileMeta
        try { meta = await saveEntry(token, entry, folderId, undefined, undefined, id) }
        catch (e) {
          if (!(e instanceof DriveError && e.status === 409)) throw e
          meta = await getDiaryFileMeta(token, input.sessionId, session, this.env, id, input.date)
          await this.ctx.storage.put(key, meta.id)
          const existing = await getEntryContent(token, meta.id, input.date)
          if (existing.content !== entry.content) throw new DriveConflictError()
        }
        await this.ctx.storage.put(key, meta.id)
        await this.ctx.storage.delete(reservationKey)
        return meta
      }
      const headers = new Headers()
      if (input.fileId) headers.set('X-Linger-File-Id', input.fileId)
      if (input.baseVersion) headers.set('If-Match', input.baseVersion)
      const mirrorAuth = { sessionId: input.sessionId, accountKey: input.accountKey, date: input.date }
      const context = {
        request: new Request('https://diary-writer.internal/', { method: input.method, headers, ...(input.method === 'POST' ? { body: input.body } : {}) }),
        params: { date: input.date }, env: this.env,
        data: { sessionId: input.sessionId, accessToken: token, session },
        waitUntil: (promise: Promise<unknown>) => this.ctx.waitUntil(promise),
        findEntry, createEntry,
        onSaved: (meta: DriveFileMeta) => mirrorEntryForAuth(this.env, { ...mirrorAuth, fileId: meta.id, driveVersion: meta.version }).catch(error => console.error('Diary mirror scheduling failed', error)),
        onRemoved: () => deleteEntryForAuth(this.env, mirrorAuth).catch(error => console.error('Diary deletion mirror scheduling failed', error)),
      }
      const response = await (input.method === 'POST' ? saveDiaryEntry(context) : removeDiaryEntry(context))
      if (session.folder_id) await this.ctx.storage.put('folder', session.folder_id)
      if (response.ok && input.method === 'DELETE') {
        await this.ctx.storage.delete([key, reservationKey])
      } else if (response.ok) {
        const meta = await response.clone().json() as DriveFileMeta
        await this.ctx.storage.put(key, meta.id)
      }
      return response
    })
  }
}
