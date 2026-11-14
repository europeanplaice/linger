import type { Env, SessionData } from './session'
import { jsonResponse, saveSession } from './session'
import { ensureFolder, listEntries, writeJsonFile } from './drive'
import {
  DIARY_FILENAME_RE, S3_SETTINGS_FILE_NAME, finishBackfill, isBackfillRunActive,
  isValidS3Settings, loadS3SettingsRecord, backfillAllEntries, resyncSingleEntry,
  writeBackfillProgress, type S3SettingsRecord,
} from './s3Settings'
import type { S3BackupOperation } from './s3Workflow'

async function beginBackfill(token: string, sessionId: string, session: SessionData, env: Env, record: S3SettingsRecord, dates?: string[]): Promise<void> {
  const scope = dates ?? (await listEntries(token, sessionId, session, env))
    .flatMap(meta => { const date = meta.name.match(DIARY_FILENAME_RE)?.[1]; return date ? [date] : [] })
  const remaining = [...new Set(scope)]
  await writeBackfillProgress(token, record, { total: remaining.length, done: 0, failed: [], remaining })
  if (!remaining.length) await finishBackfill(token, record, 0, [], 'Backfill')
}

// Called with a fresh, authorized session *inside* S3SyncIndex's serial queue.
// Progress remains in the user's Drive. No dates or credentials are persisted
// in the coordinator's own storage.
export async function executeS3Backup(token: string, sessionId: string, session: SessionData, env: Env, operation: S3BackupOperation): Promise<Response> {
  if (operation.kind === 'start' && operation.dates?.some(date => !/^\d{4}-\d{2}-\d{2}$/.test(date))) {
    return jsonResponse({ error: 'Invalid date' }, 400)
  }
  // A different device may have enabled backup or created progress since this
  // session's last request. Negative caches cannot authorize a mutation.
  session.s3_settings_negative_cache_at = undefined
  session.s3_status_negative_cache_at = undefined
  const record = await loadS3SettingsRecord(token, sessionId, session, env)
  if (operation.kind === 'settings') {
    if (!isValidS3Settings(operation.config)) return jsonResponse({ error: 'Invalid S3 settings' }, 400)
    const { enabled, roleArn, bucket, region } = operation.config
    const config = { enabled, roleArn, bucket, region }
    const targetChanged = !!record && (record.config.bucket !== bucket || record.config.region !== region || record.config.roleArn !== roleArn)
    if (isBackfillRunActive(record?.status.backfillProgress) && (targetChanged || !enabled)) {
      return jsonResponse({ error: 'Wait for the active backup run to finish before changing its target or disabling backup' }, 409)
    }
    const needsBackfill = enabled && (!record?.config.enabled || targetChanged)
    const folderId = record?.folderId ?? await ensureFolder(token, sessionId, session, env)
    const nextRecord: S3SettingsRecord = { config, status: record?.status ?? {}, folderId, configFileId: record?.configFileId ?? '', statusFileId: record?.statusFileId ?? null }
    // Reserve and checkpoint the scope before enabling/changing the target. A
    // failed progress write must not leave backup enabled with no resumable run.
    if (needsBackfill) await beginBackfill(token, sessionId, session, env, nextRecord)
    const meta = await writeJsonFile(token, folderId, S3_SETTINGS_FILE_NAME, config, record?.configFileId)
    session.s3_settings_file_id = meta.id
    await saveSession(sessionId, session, env)
    // Preserve failures and an unfinished run on a plain settings save.
    return jsonResponse(meta)
  }
  if (!record) {
    if (operation.kind === 'reconcile') return jsonResponse({ ok: true })
    return jsonResponse({ error: 'S3 backup is not configured' }, 400)
  }
  if (!record.config.enabled) {
    if (operation.kind === 'reconcile') return jsonResponse({ ok: true })
    return jsonResponse({ error: 'S3 backup is not enabled' }, 400)
  }
  if (operation.kind === 'reconcile') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(operation.date)) return jsonResponse({ error: 'Invalid date' }, 400)
    const result = await resyncSingleEntry(token, sessionId, session, env, record, operation.date)
    return jsonResponse(result, result.ok ? 200 : 502)
  }
  const progress = record.status.backfillProgress
  if (operation.kind === 'continue') {
    if (!progress || progress.finishedAt) return jsonResponse({ ok: true, done: true })
    // Old progress without a resumable scope is unsafe. Rebuild from Drive rather
    // than declaring unseen entries complete.
    if (!progress.remaining) {
      await beginBackfill(token, sessionId, session, env, record)
    } else if (!progress.remaining.length) {
      await finishBackfill(token, record, progress.total, progress.failed, 'Backfill')
    } else {
      await backfillAllEntries(token, sessionId, session, env, record, progress.remaining, 'Backfill', 20)
    }
    return jsonResponse({ ok: true, remaining: record.status.backfillProgress?.remaining?.length ?? 0 })
  }
  if (isBackfillRunActive(progress)) return jsonResponse({ error: 'A backfill is already running' }, 409)
  if (operation.kind === 'retry') {
    const failed = progress?.failed ?? []
    if (!failed.length) return jsonResponse({ error: 'No failed entries to retry' }, 400)
    await beginBackfill(token, sessionId, session, env, record, failed)
    return jsonResponse({ ok: true, retrying: failed.length })
  }
  await beginBackfill(token, sessionId, session, env, record, operation.dates)
  return jsonResponse({ ok: true })
}
