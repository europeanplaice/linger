import type { Env, Data } from '../../_shared/session'
import { jsonResponse, getValidIdToken } from '../../_shared/session'
import { listObjectKeys, getObjectContent, S3Error, describeError } from '../../_shared/s3'
import { listEntries, findEntryMeta, ensureFolder, saveEntry, DriveError } from '../../_shared/drive'
import { loadS3SettingsRecord, getAssumedCredentials, entryKey, DIARY_FILENAME_RE, mirrorEntrySave } from '../../_shared/s3Settings'

// Restore-from-backup: the mirror is write-only everywhere else, so if an entry
// disappears from Drive (deleted, trashed, or lost in a botched resync) there was
// no way to get its content back from the bucket. This endpoint is the read path:
// GET lists dates that exist in the bucket but not in Drive (the restore
// candidates — the S3 object is the only surviving copy), POST recreates one of
// them in Drive from the current bucket content. Old *versions* of entries that
// still exist in Drive aren't surfaced here — that's the revisions/History path.
export const onRequestGet: PagesFunction<Env, string, Data> = async (context) => {
  const { accessToken, sessionId, session } = context.data
  if (!session) return jsonResponse({ error: 'Unauthorized' }, 401)

  try {
    const record = await loadS3SettingsRecord(accessToken, sessionId, session, context.env)
    if (!record) return jsonResponse({ error: 'S3 backup is not configured' }, 400)
    if (!record.config.enabled) return jsonResponse({ error: 'S3 backup is not enabled' }, 400)

    const idToken = await getValidIdToken(sessionId, session, context.env)
    if (!idToken) return jsonResponse({ ok: false, error: 'No Google ID token in this session — sign out and sign in again' })

    const creds = await getAssumedCredentials(idToken, sessionId, session, context.env, record.config)
    const [bucketKeys, entries] = await Promise.all([
      listObjectKeys(creds, record.config.bucket, record.config.region, 'diary-'),
      listEntries(accessToken, sessionId, session, context.env),
    ])
    const driveDates = new Set(entries
      .map(e => e.name.match(DIARY_FILENAME_RE)?.[1])
      .filter((date): date is string => !!date))
    const dates = bucketKeys
      .map(key => key.match(DIARY_FILENAME_RE)?.[1])
      .filter((date): date is string => !!date && !driveDates.has(date))
      .sort()
    return jsonResponse({ dates })
  } catch (e) {
    if (e instanceof S3Error) {
      console.error('s3/restore.ts: candidate listing failed', e)
      return jsonResponse({ ok: false, error: describeError(e) }, 500)
    }
    console.error('s3/restore.ts: unexpected failure listing candidates', e)
    return jsonResponse({ ok: false, error: 'Unexpected error' }, 500)
  }
}

// Recreates one date's entry in Drive from its S3 backup. Refuses if the entry
// reappeared in Drive since the candidate list was built (a restore must never
// clobber a live entry — the user can open it and use History instead).
export const onRequestPost: PagesFunction<Env, string, Data> = async (context) => {
  const { accessToken, sessionId, session } = context.data
  if (!session) return jsonResponse({ error: 'Unauthorized' }, 401)

  let body: unknown
  try {
    body = await context.request.json()
  } catch {
    return jsonResponse({ ok: false, error: 'Invalid JSON' })
  }
  const date = (body as Record<string, unknown> | null)?.date
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return jsonResponse({ ok: false, error: 'Invalid date' }, 400)
  }

  try {
    const record = await loadS3SettingsRecord(accessToken, sessionId, session, context.env)
    if (!record) return jsonResponse({ error: 'S3 backup is not configured' }, 400)
    if (!record.config.enabled) return jsonResponse({ error: 'S3 backup is not enabled' }, 400)

    const idToken = await getValidIdToken(sessionId, session, context.env)
    if (!idToken) return jsonResponse({ ok: false, error: 'No Google ID token in this session — sign out and sign in again' })

    const creds = await getAssumedCredentials(idToken, sessionId, session, context.env, record.config)
    const content = await getObjectContent(creds, record.config.bucket, record.config.region, entryKey(date))
    if (content === null) return jsonResponse({ ok: false, error: 'No backup for this entry in the bucket' }, 404)

    const existing = await findEntryMeta(accessToken, sessionId, session, context.env, date)
    if (existing) return jsonResponse({ ok: false, error: 'This entry already exists in Drive' }, 409)

    const folderId = await ensureFolder(accessToken, sessionId, session, context.env)
    const savedMeta = await saveEntry(accessToken, { date, content }, folderId)
    // Stamp the fresh Drive version back onto the mirror (mirrorEntrySave's
    // putObjectIfNewer) so the object's linger-version metadata matches the
    // recreated file and the sync badge resolves to 'synced' — also rewrites
    // history as a new bucket version, same as any normal save.
    context.waitUntil(mirrorEntrySave(accessToken, sessionId, session, context.env, date, content, savedMeta.id, savedMeta.version))
    return jsonResponse({ ok: true, meta: savedMeta })
  } catch (e) {
    if (e instanceof S3Error) {
      console.error('s3/restore.ts: restore failed', e)
      return jsonResponse({ ok: false, error: describeError(e) })
    }
    if (e instanceof DriveError) {
      console.error('s3/restore.ts: Drive write failed', e)
      return jsonResponse({ ok: false, error: e.message }, e.status)
    }
    console.error('s3/restore.ts: unexpected failure', e)
    return jsonResponse({ ok: false, error: 'Unexpected error' })
  }
}
