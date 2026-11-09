import { DurableObject } from 'cloudflare:workers'
import type { DiaryMutationInput, DiaryWriterAuth } from '../../../functions/_shared/diaryWriter'
import { removeDiaryEntry, saveDiaryEntry } from '../../../functions/_shared/entryMutation'
import { mirrorEntryDelete, mirrorEntrySave } from '../../../functions/_shared/s3Settings'
import { DriveConflictError, DriveError, ensureFolder, findEntryMeta, generateFileId, getDiaryFileMeta, getEntryContent, getEntryMeta, listDriveFolders, saveEntry } from '../../../functions/_shared/drive'
import type { DiaryEntry, DriveFileMeta } from '../../../functions/_shared/drive'
import { invalidateFolderScopedS3Cache, jsonResponse, saveSession } from '../../../functions/_shared/session'
import type { SessionData } from '../../../functions/_shared/session'
import { authorizedSession } from './runtime'
import type { WorkflowEnv } from './types'
import { openVaultValue, sealVaultValue, vaultLookupKey } from '../../../functions/_shared/vaultCrypto'

// One object per internal Linger account and deployment environment. All
// sessions/devices use this queue, including folder discovery and restores. Do not hold a storage
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
    await this.migrateLegacyMetadata(auth)
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

  async selectFolder(input: DiaryWriterAuth & { folderId: string }): Promise<string> {
    // A rebind must not race a write already executing or waiting in this
    // account queue. Later writes queue behind the completed rebind and use its
    // new pointer.
    if (this.queued !== 0) throw new DriveError(409, 'Diary activity is in progress; try selecting the folder again')
    return this.serialize(async () => {
      const session = await this.session(input)
      const candidates = await listDriveFolders(input.accessToken)
      if (!candidates.some(folder => folder.id === input.folderId)) {
        throw new DriveError(400, 'Selected folder is not available to this Google account')
      }
      const meta = await getEntryMeta(input.accessToken, input.folderId)
      if (meta.id !== input.folderId || meta.mimeType !== 'application/vnd.google-apps.folder' || meta.trashed) {
        throw new DriveError(400, 'Selected item is not an available Drive folder')
      }

      const currentFolder = await this.readMetadata<string>('folder', input)
      if (currentFolder === input.folderId) return currentFolder

      // Clear old-folder S3 status only after the request has passed all
      // checks and the writer queue is clear. resetAllData refuses to proceed
      // while a live backfill is running, leaving both folder pointers intact.
      await this.env.S3_SYNC_INDEX.getByName(input.accountKey).resetAllData()

      // Clear per-date Drive IDs and pending create reservations before the new
      // pointer is visible. A failure here leaves the old folder selected with
      // empty, safely reconstructible caches.
      const [files, creates] = await Promise.all([
        this.ctx.storage.list({ prefix: 'file:' }),
        this.ctx.storage.list({ prefix: 'create:' }),
      ])
      const cacheKeys = [...files.keys(), ...creates.keys()]
      for (let i = 0; i < cacheKeys.length; i += 128) {
        await this.ctx.storage.delete(cacheKeys.slice(i, i + 128))
      }

      session.folder_id = input.folderId
      session.changes_start_page_token = undefined
      invalidateFolderScopedS3Cache(session)
      await this.writeMetadata('folder', input, input.folderId)
      await saveSession(input.sessionId, session, this.env)
      return input.folderId
    })
  }

  async mutate(input: DiaryMutationInput): Promise<Response> {
    return this.serialize(async () => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !['POST', 'DELETE'].includes(input.method)) {
        return jsonResponse({ error: 'Invalid diary mutation' }, 400)
      }
      const session = await this.session(input)
      await this.folder(input, session)
      const token = input.accessToken
      if (!input.vaultKey) throw new Error('Vault key required to access protected Drive metadata')
      const dateKey = await vaultLookupKey(input.vaultKey, input.accountKey, 'diary-writer-date', input.date)
      const key = `file:v2:${dateKey}`
      const reservationKey = `create:v2:${dateKey}`
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

  private async migrateDateMetadata(oldKey: string, newKey: string, auth: DiaryWriterAuth): Promise<void> {
    const raw = await this.ctx.storage.get<unknown>(oldKey)
    // A reservation from the pre-envelope format may already name a Drive file
    // created before a response was lost. Preserve its ID when it has the
    // expected shape; the create path still checks its folder and Drive result.
    const legacyReservation = oldKey.startsWith('create:') && raw !== null && typeof raw === 'object'
      && 'id' in raw && typeof raw.id === 'string' && raw.id.length > 0 && raw.id.length <= 512
      && 'folderId' in raw && typeof raw.folderId === 'string' && raw.folderId.length > 0 && raw.folderId.length <= 512
      ? { id: raw.id, folderId: raw.folderId } : undefined
    const old = legacyReservation ?? await this.readMetadata<unknown>(oldKey, auth)
    if (old === undefined) return
    // A completed new write takes precedence if a previous migration was interrupted.
    const existing = await this.ctx.storage.get<unknown>(newKey)
    if (existing === undefined) {
      await this.writeMetadata(newKey, auth, old)
    } else {
      if (typeof existing !== 'string' || !auth.vaultKey) throw new Error('Invalid protected diary metadata')
      await openVaultValue(auth.vaultKey, auth.accountKey, `diary-writer:${newKey}`, existing)
    }
    await this.ctx.storage.delete(oldKey)
  }

  private async migrateLegacyMetadata(auth: DiaryWriterAuth): Promise<void> {
    if (!auth.vaultKey) throw new Error('Vault key required to access protected Drive metadata')
    // Retain create reservations: they are needed to safely retry an ambiguous
    // Drive create. A restart can repeat this migration without replacing a more
    // recent v2 value. Never store the vault key or plaintext date in v2 keys.
    for (const prefix of ['file:', 'create:']) {
      // Legacy dates start with a digit; v2 digests start with "v2:". Avoid
      // loading every already-migrated entry on each diary operation.
      const rows = await this.ctx.storage.list({ prefix, start: `${prefix}0`, end: `${prefix}:` })
      for (const oldKey of rows.keys()) {
        const date = oldKey.slice(prefix.length)
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
        const digest = await vaultLookupKey(auth.vaultKey, auth.accountKey, 'diary-writer-date', date)
        await this.migrateDateMetadata(oldKey, `${prefix}v2:${digest}`, auth)
      }
    }
  }

  private async writeMetadata(storageKey: string, auth: DiaryWriterAuth, value: unknown): Promise<void> {
    if (!auth.vaultKey) throw new Error('Vault key required to persist protected Drive metadata')
    const envelope = await sealVaultValue(auth.vaultKey, auth.accountKey, `diary-writer:${storageKey}`, value)
    await this.ctx.storage.put(storageKey, envelope)
  }
}
