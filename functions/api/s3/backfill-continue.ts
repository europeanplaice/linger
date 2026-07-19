import type { Env, Data } from '../../_shared/session'
import { jsonResponse } from '../../_shared/session'
import { ensureFolder, findJsonFile, readJsonFile, listEntries } from '../../_shared/drive'
import {
  S3_SETTINGS_FILE_NAME, isValidS3Settings, backfillAllEntries, finishBackfill,
  DIARY_FILENAME_RE, type S3SettingsRecord,
} from '../../_shared/s3Settings'

const BACKFILL_CHUNK_SIZE = 20

// Continues a chunked backfill that was previously started but not yet finished.
// The client calls this endpoint repeatedly (driven by its polling loop) until
// backfillProgress.finishedAt is set. Each invocation processes at most
// BACKFILL_CHUNK_SIZE entries, well within Cloudflare Pages Functions' timeout.
export const onRequestPost: PagesFunction<Env, string, Data> = async (context) => {
  const { accessToken, sessionId, session } = context.data
  if (!session) return jsonResponse({ error: 'Unauthorized' }, 401)

  try {
    const folderId = await ensureFolder(accessToken, sessionId, session, context.env)
    const fileId = await findJsonFile(accessToken, folderId, S3_SETTINGS_FILE_NAME)
    if (!fileId) return jsonResponse({ error: 'S3 backup is not configured' }, 400)

    const settings = await readJsonFile<unknown>(accessToken, fileId)
    if (!isValidS3Settings(settings) || !settings.enabled) {
      return jsonResponse({ error: 'S3 backup is not enabled' }, 400)
    }

    const progress = settings.backfillProgress
    const record: S3SettingsRecord = { settings, folderId, fileId }

    // Nothing to do: backfill already finished.
    if (progress?.finishedAt) {
      return jsonResponse({ ok: true, done: true })
    }

    // No progress record yet — the initial/resync chunk is still in-flight or
    // already finished and cleared the record. Don't start a brand-new backfill
    // here; the trigger endpoint (settings.ts / resync.ts / backfill-retry.ts)
    // is responsible for kicking off the first chunk. Return done: false so the
    // client keeps polling and re-checks once progress appears.
    if (!progress) {
      return jsonResponse({ ok: true, done: false })
    }

    // List all diary entries so we can determine which ones remain.
    const allEntries = (await listEntries(accessToken, sessionId, session, context.env))
      .map(meta => ({ meta, date: meta.name.match(DIARY_FILENAME_RE)?.[1] }))
      .filter((e): e is { meta: typeof e.meta; date: string } => !!e.date)

    let remainingDates: string[]
    if (progress.failed.length > 0 && progress.done >= progress.total) {
      // Previous run finished but had failures — retry only those dates.
      remainingDates = progress.failed
    } else {
      // Ongoing initial/resync backfill — skip the entries already processed.
      remainingDates = allEntries.slice(progress.done).map(e => e.date)
    }

    if (remainingDates.length === 0) {
      // Either all entries are synced, or entries were deleted mid-backfill and the
      // positional slice now yields nothing. Finalise in both cases.
      if (progress.done < progress.total) {
        await finishBackfill(accessToken, record, progress.total, progress.failed, 'Backfill')
      }
      return jsonResponse({ ok: true, done: true })
    }

    const chunk = remainingDates.slice(0, BACKFILL_CHUNK_SIZE)
    // Fire-and-forget inside waitUntil so the response returns immediately.
    // The client's polling loop will call this endpoint again if more entries remain.
    context.waitUntil(backfillAllEntries(
      accessToken, sessionId, session, context.env,
      settings, folderId, fileId, chunk, 'Backfill', BACKFILL_CHUNK_SIZE,
    ))

    return jsonResponse({ ok: true, remaining: remainingDates.length })
  } catch (e) {
    console.error('s3/backfill-continue.ts: POST failed', e)
    return jsonResponse({ error: 'Internal server error' }, 500)
  }
}
