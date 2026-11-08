import { DurableObject } from 'cloudflare:workers'
import type { DiaryMutationInput, DiaryWriterAuth } from '../../../functions/_shared/diaryWriter'
import { removeDiaryEntry, saveDiaryEntry } from '../../../functions/_shared/entryMutation'
import { mirrorEntryDelete, mirrorEntrySave } from '../../../functions/_shared/s3Settings'
import { DriveConflictError, DriveError, ensureFolder, findEntryMeta, generateFileId, getDiaryFileMeta, getEntryContent, getEntryMeta, saveEntry } from '../../../functions/_shared/drive'
import type { DiaryEntry, DriveFileMeta } from '../../../functions/_shared/drive'
import { invalidateFolderScopedS3Cache, jsonResponse, saveSession } from '../../../functions/_shared/session'
import type { SessionData } from '../../../functions/_shared/session'
import { authorizedSession } from './runtime'
import type { WorkflowEnv } from './types'
import { openVaultValue, sealVaultValue } from '../../../functions/_shared/vaultCrypto'

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
    if (!auth.accessToken || auth.expiresAt <= Date.now()) throw new Error('Google access token expired')
    session.access_token = auth.accessToken
    session.expires_at = auth.expiresAt
    session.id_token = auth.idToken
    session.id_token_verified = Boolean(auth.idToken)
    return session
  }

  private async folder(auth: DiaryWriterAuth, session: SessionData): Promise<string> {
    const token = auth.accessToken
    const sessionFolderId = session.folder_id
    let stored = await this.readMetadata<string>('folder', auth)
    if (stored) session.folder_id = stored
    // A persisted pointer must not pin an account to a folder the user has
    // since deleted/trashed in Drive. Preserve transient errors; only absence
    // or a non-folder invalidates the pointer.
    if (session.folder_id) {
      try {
        const meta = await getEntryMeta(token, session.folder_id)
        if (meta.trashed || meta.mimeType !== 'application/vnd.google-apps.folder') throw new DriveError(404, 'not_found')
      } catch (error) {
        if (!(error instanceof DriveError && error.status === 404)) throw error
        session.folder_id = stored ? sessionFolderId : undefined
        await this.ctx.storage.delete('folder')
        stored = undefined
        if (session.folder_id) {
          try {
            const fallbackMeta = await getEntryMeta(token, session.folder_id)
            if (fallbackMeta.trashed || fallbackMeta.mimeType !== 'application/vnd.google-apps.folder') {
              throw new DriveError(404, 'not_found')
            }
          } catch (fallbackError) {
            if (!(fallbackError instanceof DriveError && fallbackError.status === 404)) throw fallbackError
            session.folder_id = undefined
          }
        }
      }
    }
    const id = await ensureFolder(token, auth.sessionId, session, this.env, {
      withinCoordinator: true,
      discoverByName: !stored,
    })
    session.folder_id = id
    await this.writeMetadata('folder', auth, id)
    // A stored account pointer may replace a different per-session cache. Keep
    // the session aligned so later requests do not resurrect the stale ID.
    if (sessionFolderId !== id) {
      invalidateFolderScopedS3Cache(session)
      await saveSession(auth.sessionId, session, this.env)
    }
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
      const token = input.accessToken
      const key = `file:${input.date}`
      const reservationKey = `create:${input.date}`
      const findEntry = async (): Promise<DriveFileMeta | null> => {
        const known = await this.readMetadata<string>(key, input)
        if (known) {
          try { return await getDiaryFileMeta(token, input.sessionId, session, this.env, known, input.date, { withinCoordinator: true }) }
          catch (e) { if (!(e instanceof DriveError && e.status === 404)) throw e }
          await this.ctx.storage.delete(key)
        }
        const meta = await findEntryMeta(token, input.sessionId, session, this.env, input.date, { withinCoordinator: true })
        if (meta) await this.writeMetadata(key, input, meta.id)
        return meta
      }
      const createEntry = async (entry: DiaryEntry, folderId: string): Promise<DriveFileMeta> => {
        // Persist a Drive-generated ID BEFORE creating. A timeout, lost response,
        // or object restart can retry this ID without creating a second file.
        let reservation = await this.readMetadata<{ id: string; folderId: string }>(reservationKey, input)
        if (!reservation || reservation.folderId !== folderId) {
          reservation = { id: await generateFileId(token), folderId }
          await this.writeMetadata(reservationKey, input, reservation)
        }
        const { id } = reservation
        let meta: DriveFileMeta
        try { meta = await saveEntry(token, entry, folderId, undefined, undefined, id) }
        catch (e) {
          if (!(e instanceof DriveError && e.status === 409)) throw e
          meta = await getDiaryFileMeta(token, input.sessionId, session, this.env, id, input.date, { withinCoordinator: true })
          await this.writeMetadata(key, input, meta.id)
          const existing = await getEntryContent(token, meta.id, input.date)
          if (existing.content !== entry.content) throw new DriveConflictError()
        }
        await this.writeMetadata(key, input, meta.id)
        await this.ctx.storage.delete(reservationKey)
        return meta
      }
      const headers = new Headers()
      if (input.fileId) headers.set('X-Linger-File-Id', input.fileId)
      if (input.baseVersion) headers.set('If-Match', input.baseVersion)
      const context = {
        request: new Request('https://diary-writer.internal/', { method: input.method, headers, ...(input.method === 'POST' ? { body: input.body } : {}) }),
        params: { date: input.date }, env: this.env,
        data: { sessionId: input.sessionId, accessToken: token, session },
        waitUntil: (promise: Promise<unknown>) => this.ctx.waitUntil(promise),
        findEntry, createEntry,
        onSaved: (meta: DriveFileMeta) => mirrorEntrySave(token, input.sessionId, session, this.env, input.date, (input.body ? JSON.parse(input.body) as { content?: string } : {}).content ?? '', meta.id, meta.version),
        onRemoved: () => mirrorEntryDelete(token, input.sessionId, session, this.env, input.date),
      }
      const response = await (input.method === 'POST' ? saveDiaryEntry(context) : removeDiaryEntry(context))
      if (session.folder_id) await this.writeMetadata('folder', input, session.folder_id)
      if (response.ok && input.method === 'DELETE') {
        await this.ctx.storage.delete([key, reservationKey])
      } else if (response.ok) {
        const meta = await response.clone().json() as DriveFileMeta
        await this.writeMetadata(key, input, meta.id)
      }
      return response
    })
  }

  private async readMetadata<T>(storageKey: string, auth: DiaryWriterAuth): Promise<T | undefined> {
    if (!auth.vaultKey) throw new Error('Vault key required to access protected Drive metadata')
    const envelope = await this.ctx.storage.get<string>(storageKey)
    if (envelope === undefined) return undefined
    // The prior DO namespace used Google subjects. Any value reached through a
    // new user_id namespace without a versioned envelope is legacy plaintext or
    // an old object-shaped reservation. Drop it and reconstruct from Drive.
    if (typeof envelope !== 'string' || !envelope.startsWith('v1.')) {
      await this.ctx.storage.delete(storageKey)
      return undefined
    }
    return openVaultValue<T>(auth.vaultKey, auth.accountKey, `diary-writer:${storageKey}`, envelope)
  }

  private async writeMetadata(storageKey: string, auth: DiaryWriterAuth, value: unknown): Promise<void> {
    if (!auth.vaultKey) throw new Error('Vault key required to persist protected Drive metadata')
    const envelope = await sealVaultValue(auth.vaultKey, auth.accountKey, `diary-writer:${storageKey}`, value)
    await this.ctx.storage.put(storageKey, envelope)
  }
}
