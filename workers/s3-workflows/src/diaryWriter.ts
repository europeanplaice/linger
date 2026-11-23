import { DurableObject } from 'cloudflare:workers'
import type { DiaryMutationInput, DiaryUploadInput, DiaryUploadResult, DiaryWriterAuth } from '../../../functions/_shared/diaryWriter'
import { DIARY_UPLOAD_URL, diaryUploadResponse } from '../../../functions/_shared/diaryWriter'
import { removeDiaryEntry, saveDiaryEntry } from '../../../functions/_shared/entryMutation'
import { mirrorCurrentEntry, mirrorEntryDelete, mirrorEntrySave } from '../../../functions/_shared/s3Settings'
import { beginEntryUpload, cancelEntryUpload, DriveConflictError, DriveError, ensureFolder, entryUploadStatus, findEntryMeta, generateFileId, getDiaryFileMeta, getEntryContent, getEntryMeta, inspectDriveFolder, listDriveFolders, saveEntry } from '../../../functions/_shared/drive'
import type { DiaryEntry, DriveFileMeta } from '../../../functions/_shared/drive'
import { invalidateFolderScopedS3Cache, jsonResponse, saveSession } from '../../../functions/_shared/session'
import type { SessionData } from '../../../functions/_shared/session'
import { authorizedSession } from './runtime'
import type { WorkflowEnv } from './types'
import { openVaultValue, sealVaultValue, vaultLookupKey } from '../../../functions/_shared/vaultCrypto'

const PENDING_UPLOAD_PREFIX = 'upload:pending:'
const UPLOAD_RECEIPT_PREFIX = 'upload:receipt:'
const UPLOAD_IDLE_MS = 60_000
const MAX_PENDING_UPLOADS = 32
interface PendingUpload {
  operationId: string
  date: string
  fileId: string
  url: string
  bytes: number
  startedAt: number
}
interface CompletedUpload {
  operationId: string
  meta: DriveFileMeta
}
const uploadBusy = {
  status: 429,
  body: { error: 'A diary upload is in progress' },
  retryAfter: '1',
} satisfies DiaryUploadResult

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
    return this.serialize(async () => {
      const session = await this.session(auth)
      const folderId = await this.folder(auth, session)
      // A page may close after the upload but before reporting completion.
      // Reading or opening the app still works while another tab is uploading.
      await this.recoverPendingUploads(auth, session).catch(() => {})
      return folderId
    })
  }

  async getEntryMeta(input: DiaryWriterAuth & { date: string }): Promise<DriveFileMeta | null> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error('Invalid date')
    return this.serialize(async () => {
      const session = await this.session(input)
      await this.folder(input, session)
      if (!input.vaultKey) throw new Error('Vault key required to access protected Drive metadata')
      const dateKey = await vaultLookupKey(input.vaultKey, input.accountKey, 'diary-writer-date', input.date)
      const key = `file:v2:${dateKey}`
      return this.findIndexedEntry(input, session, input.date, key)
    })
  }

  async selectFolder(input: DiaryWriterAuth & { folderId: string; allowEmpty?: boolean }): Promise<string> {
    // A rebind must not race a write already executing or waiting in this
    // account queue. Later writes queue behind the completed rebind and use its
    // new pointer.
    if (this.queued !== 0) throw new DriveError(409, 'Diary activity is in progress; try selecting the folder again')
    return this.serialize(async () => {
      const session = await this.session(input)
      if (!await this.recoverPendingUploads(input, session)) {
        throw new DriveError(409, 'Diary activity is in progress; try selecting the folder again')
      }
      const candidates = await listDriveFolders(input.accessToken)
      if (!candidates.some(folder => folder.id === input.folderId)) {
        throw new DriveError(400, 'Selected folder is not available to this Google account')
      }
      // Recheck permissions and contents inside the writer queue, even when
      // the client already inspected this folder.
      const inspection = await inspectDriveFolder(input.accessToken, input.folderId)
      if (!inspection.canAddChildren) throw new Error('FOLDER_READ_ONLY')

      const currentFolder = await this.readMetadata<string>('folder', input)
      if (currentFolder === input.folderId) return currentFolder
      if (inspection.entryCount === 0 && input.allowEmpty !== true) throw new Error('FOLDER_EMPTY')

      // Clear old-folder S3 status only after the request has passed all
      // checks and the writer queue is clear. resetAllData refuses to proceed
      // while a live backfill is running, leaving both folder pointers intact.
      await this.env.S3_SYNC_INDEX.getByName(input.accountKey).resetAllData()

      // Clear per-date Drive IDs and pending create reservations before the new
      // pointer is visible. A failure here leaves the old folder selected with
      // empty, safely reconstructible caches.
      const [files, creates, receipts] = await Promise.all([
        this.ctx.storage.list({ prefix: 'file:' }),
        this.ctx.storage.list({ prefix: 'create:' }),
        this.ctx.storage.list({ prefix: UPLOAD_RECEIPT_PREFIX }),
      ])
      const cacheKeys = [...files.keys(), ...creates.keys(), ...receipts.keys()]
      for (let i = 0; i < cacheKeys.length; i += 128) {
        await this.ctx.storage.delete(cacheKeys.slice(i, i + 128))
      }

      session.folder_id = input.folderId
      session.changes_start_page_token = undefined
      invalidateFolderScopedS3Cache(session)
      await this.writeMetadata('folder', input, input.folderId)
      await saveSession(input.sessionId, session, this.env)
      return input.folderId
    }).catch(error => {
      // Custom Error properties do not survive every service/DO RPC boundary.
      // Keep expected Drive failures recognizable by the Pages handler.
      if (error instanceof DriveError) {
        if (error.status === 401) throw new Error('FOLDER_AUTH_EXPIRED')
        if (error.status === 403) throw new Error('FOLDER_PERMISSION_DENIED')
        if (error.status === 404) throw new Error('FOLDER_UNAVAILABLE')
        if (error.status === 429) throw new Error('FOLDER_RATE_LIMITED')
      }
      throw error
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
      const upload = await this.readMetadata<PendingUpload>(`${PENDING_UPLOAD_PREFIX}${dateKey}`, input)
      if (upload && await this.recoverUpload(input, session, dateKey, upload) === 'incomplete') {
        return jsonResponse(uploadBusy.body, uploadBusy.status, { 'Retry-After': uploadBusy.retryAfter })
      }
      const key = `file:v2:${dateKey}`
      const reservationKey = `create:v2:${dateKey}`
      const findEntry = () => this.findIndexedEntry(input, session, input.date, key)
      const createEntry = async (entry: DiaryEntry, folderId: string): Promise<DriveFileMeta> => {
        // Persist a Drive-generated ID BEFORE creating. A timeout, lost response,
        // or object restart can retry this ID without creating a second file.
        const id = await this.reserveEntryId(input, folderId, reservationKey)
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

  private async findIndexedEntry(auth: DiaryWriterAuth, session: SessionData, date: string, key: string): Promise<DriveFileMeta | null> {
    const known = await this.readMetadata<string>(key, auth)
    if (known) {
      const meta = await this.lookupEntry(auth, session, date, known)
      if (meta) return meta
      await this.ctx.storage.delete(key)
    }
    const meta = await findEntryMeta(auth.accessToken, auth.sessionId, session, this.env, date, { withinCoordinator: true })
    if (meta) await this.writeMetadata(key, auth, meta.id)
    return meta
  }

  private async lookupEntry(auth: DiaryWriterAuth, session: SessionData, date: string, id: string): Promise<DriveFileMeta | null> {
    try {
      return await getDiaryFileMeta(auth.accessToken, auth.sessionId, session, this.env, id, date, { withinCoordinator: true })
    } catch (error) {
      if (error instanceof DriveError && error.status === 404) return null
      throw error
    }
  }

  private async reserveEntryId(auth: DiaryWriterAuth, folderId: string, key: string): Promise<string> {
    const reservation = await this.readMetadata<{ id: string; folderId: string }>(key, auth)
    if (reservation?.folderId === folderId) return reservation.id
    const id = await generateFileId(auth.accessToken)
    await this.writeMetadata(key, auth, { id, folderId })
    return id
  }

  async fetch(request: Request): Promise<Response> {
    if (request.url !== DIARY_UPLOAD_URL || request.method !== 'POST') return new Response(null, { status: 404 })
    const input = await request.json<DiaryUploadInput>()
    try {
      return diaryUploadResponse(await this.upload(input))
    } catch {
      if (input.action === 'prepare') console.warn('Diary upload prepare coordinator failed')
      else console.warn('Diary upload complete coordinator failed')
      return jsonResponse({ error: 'Diary writer temporarily unavailable' }, 503)
    }
  }

  async upload(input: DiaryUploadInput): Promise<DiaryUploadResult> {
    let step = 'session'
    return this.serialize<DiaryUploadResult>(async () => {
      const session = await this.session(input)
      if (!input.vaultKey) throw new Error('Vault key required to access protected Drive metadata')
      step = 'metadata'
      const dateKey = await vaultLookupKey(input.vaultKey, input.accountKey, 'diary-writer-date', input.date)
      const pendingKey = `${PENDING_UPLOAD_PREFIX}${dateKey}`
      const receipt = await this.readMetadata<CompletedUpload>(`${UPLOAD_RECEIPT_PREFIX}${dateKey}`, input)
      if (receipt?.operationId === input.operationId) return { status: 200, body: { meta: receipt.meta } }
      const upload = await this.readMetadata<PendingUpload>(pendingKey, input)
      if (upload) {
        const matches = upload.operationId === input.operationId
        step = 'recovery'
        const result = await this.recoverUpload(input, session, dateKey, upload)
        if (result === 'incomplete') {
          if (matches && input.action === 'prepare' && input.bytes === upload.bytes) return { status: 200, body: { uploadUrl: upload.url } }
          return uploadBusy
        }
        if (matches && result !== 'expired') return { status: 200, body: { meta: result } }
      }
      if (input.action === 'complete') return { status: 409, body: { error: 'Upload session expired' } }

      const pending = await this.ctx.storage.list({ prefix: PENDING_UPLOAD_PREFIX, limit: MAX_PENDING_UPLOADS })
      if (pending.size >= MAX_PENDING_UPLOADS && !await this.recoverPendingUploads(input, session)) return uploadBusy

      step = 'folder'
      const folderId = await this.folder(input, session)
      step = 'target'
      const key = `file:v2:${dateKey}`
      const reservationKey = `create:v2:${dateKey}`
      const knownFile = input.force || input.baseVersion !== null ? input.fileId : undefined
      let meta = knownFile
        ? await this.lookupEntry(input, session, input.date, knownFile)
        : await this.findIndexedEntry(input, session, input.date, key)
      if (!meta && !knownFile) {
        const reservation = await this.readMetadata<{ id: string; folderId: string }>(reservationKey, input)
        if (reservation?.folderId === folderId) meta = await this.lookupEntry(input, session, input.date, reservation.id)
      }
      const identityMismatch = Boolean(meta && input.fileId && meta.id !== input.fileId)
      if (identityMismatch || (!meta && (knownFile || (!input.force && input.baseVersion != null)))
        || (meta && !input.force && (!meta.version || meta.version !== input.baseVersion))) {
        return { status: 409, body: { conflict: meta, canRebase: !identityMismatch && Boolean(meta?.version) } }
      }
      const fileId = meta?.id ?? await this.reserveEntryId(input, folderId, reservationKey)
      step = 'google'
      const url = await beginEntryUpload(input.accessToken, input.origin, input.date, folderId, fileId, !meta, input.bytes)
      step = 'store'
      await this.writeMetadata(pendingKey, input, {
        operationId: input.operationId, date: input.date, fileId, url, bytes: input.bytes, startedAt: Date.now(),
      } satisfies PendingUpload)
      return { status: 200, body: { uploadUrl: url } }
    }).catch(error => {
      if (error instanceof DriveError) return { status: error.status, body: { error: 'Drive upload temporarily unavailable' }, diagnostic: step }
      switch (step) {
        case 'session': console.warn('Diary upload failed during session validation'); break
        case 'metadata': console.warn('Diary upload failed while loading stored metadata'); break
        case 'recovery': console.warn('Diary upload failed while recovering an open upload'); break
        case 'folder': console.warn('Diary upload failed while resolving the folder'); break
        case 'target': console.warn('Diary upload failed while reserving a file'); break
        case 'google': console.warn('Diary upload failed while opening a Google upload session'); break
        case 'store': console.warn('Diary upload failed while saving an upload reservation'); break
      }
      if (error instanceof Error) {
        if (/hang|hung|never generate/i.test(error.message)) console.warn('Diary upload runtime reported an unresolved request')
        else if (/I\/O|canceled|cancelled/i.test(error.message)) console.warn('Diary upload runtime reported canceled I/O')
        else if (/invalid url|cannot parse url/i.test(error.message)) console.warn('Diary upload received a malformed URL')
        else if (/authorization|Unauthorized|Google access token expired/i.test(error.message)) console.warn('Diary upload authorization is unavailable')
        else if (error instanceof TypeError) console.warn('Diary upload received a TypeError')
      }
      return { status: 503, body: { error: 'Diary writer temporarily unavailable' }, diagnostic: step }
    })
  }

  private async recoverPendingUploads(auth: DiaryWriterAuth, session: SessionData): Promise<boolean> {
    const pending = await this.ctx.storage.list({ prefix: PENDING_UPLOAD_PREFIX })
    const statuses = await Promise.allSettled([...pending.keys()].map(async key => {
      const upload = await this.readMetadata<PendingUpload>(key, auth)
      return upload && this.recoverUpload(auth, session, key.slice(PENDING_UPLOAD_PREFIX.length), upload)
    }))
    return statuses.every(status => status.status === 'fulfilled' && status.value !== 'incomplete')
  }

  private async recoverUpload(auth: DiaryWriterAuth, session: SessionData, dateKey: string, upload: PendingUpload): Promise<DriveFileMeta | 'incomplete' | 'expired'> {
    const pendingKey = `${PENDING_UPLOAD_PREFIX}${dateKey}`
    let result = await entryUploadStatus(upload.url, upload.bytes)
    if (result === 'incomplete' && Date.now() >= upload.startedAt + UPLOAD_IDLE_MS) {
      // Confirm the old URL can no longer commit before allowing another writer.
      await cancelEntryUpload(upload.url)
      result = await entryUploadStatus(upload.url, upload.bytes)
    }
    if (result === 'expired') await this.ctx.storage.delete(pendingKey)
    if (typeof result === 'string') return result
    if (result.id !== upload.fileId || typeof result.version !== 'string' || typeof result.name !== 'string') {
      throw new DriveError(502, 'Unexpected Drive upload receipt')
    }
    if (!auth.vaultKey) throw new Error('Vault key required to persist protected Drive metadata')
    const fileKey = `file:v2:${dateKey}`
    const receiptKey = `${UPLOAD_RECEIPT_PREFIX}${dateKey}`
    const [fileEnvelope, receiptEnvelope] = await Promise.all([
      sealVaultValue(auth.vaultKey, auth.accountKey, `diary-writer:${fileKey}`, result.id),
      sealVaultValue(auth.vaultKey, auth.accountKey, `diary-writer:${receiptKey}`, { operationId: upload.operationId, meta: result } satisfies CompletedUpload),
    ])
    await this.ctx.storage.transaction(async txn => {
      await txn.put({ [fileKey]: fileEnvelope, [receiptKey]: receiptEnvelope })
      await txn.delete([pendingKey, `create:v2:${dateKey}`])
    })
    this.ctx.waitUntil(mirrorCurrentEntry(auth.accessToken, auth.sessionId, session, this.env, upload.date))
    return result
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
