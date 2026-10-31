import type { Env, Data } from '../../_shared/session'
import { jsonResponse, saveSession } from '../../_shared/session'
import { ensureFolder, writeJsonFile } from '../../_shared/drive'
import {
  S3_SETTINGS_FILE_NAME, S3_SYNC_STATUS_FILE_NAME, getS3Settings, isValidS3Settings, loadS3SettingsRecord, backfillAllEntries, isBackfillRunActive,
  type S3Config, type S3SettingsRecord,
} from '../../_shared/s3Settings'

export const onRequestGet: PagesFunction<Env, string, Data> = async (context) => {
  const { accessToken, sessionId, session } = context.data
  if (!session) return jsonResponse({ error: 'Unauthorized' }, 401)

  try {
    let settings = await getS3Settings(accessToken, sessionId, session, context.env)
    if (settings && context.env.S3_WORKFLOW_SERVICE && session.google_sub) {
      try {
        await context.env.S3_WORKFLOW_SERVICE.setBackupEnabled({ sessionId, accountKey: session.google_sub, enabled: settings.enabled })
        const job = await context.env.S3_WORKFLOW_SERVICE.getJob({ sessionId, accountKey: session.google_sub })
        if (job) {
          const finishedAt = job.finishedAt
          settings = {
            ...settings,
            backfillProgress: {
              total: job.total,
              done: job.completed,
              failed: job.failedDates,
              ...(finishedAt ? { finishedAt } : {}),
              updatedAt: finishedAt ?? job.startedAt,
            },
            ...(job.error ? { lastSyncError: job.error, lastSyncErrorAt: finishedAt ?? job.startedAt } : {}),
          }
        }
      } catch (e) {
        console.error('s3/settings.ts: failed to read Workflow job', e)
      }
    }
    return jsonResponse(settings)
  } catch (e) {
    console.error('s3/settings.ts: GET failed', e)
    return jsonResponse({ error: 'Internal server error' }, 500)
  }
}

export const onRequestPut: PagesFunction<Env, string, Data> = async (context) => {
  const { accessToken, sessionId, session } = context.data
  if (!session) return jsonResponse({ error: 'Unauthorized' }, 401)

  let body: unknown
  try {
    body = await context.request.json()
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400)
  }

  if (!isValidS3Settings(body)) {
    return jsonResponse({ error: 'Invalid S3 settings (check Role ARN / bucket / region format)' }, 400)
  }

  try {
    const existing = await loadS3SettingsRecord(accessToken, sessionId, session, context.env)
    const folderId = existing?.folderId ?? await ensureFolder(accessToken, sessionId, session, context.env)
    const previouslyEnabled = existing?.config.enabled ?? false

    const config: S3Config = { enabled: body.enabled, roleArn: body.roleArn, bucket: body.bucket, region: body.region }
    // The DO checks active jobs before writing Drive and serializes target changes
    // against S3 mutations. It also remembers an unstarted backfill across retries.
    const workflowSave = context.env.S3_WORKFLOW_SERVICE && session.google_sub
      ? await context.env.S3_WORKFLOW_SERVICE.saveSettings({ sessionId, accountKey: session.google_sub, config })
      : undefined
    const meta = workflowSave?.meta ?? await writeJsonFile(accessToken, folderId, S3_SETTINGS_FILE_NAME, config, existing?.configFileId)

    // Keep the session's cached fileId/negative-cache (see s3Settings.ts's
    // loadS3SettingsRecord) in sync with what was actually just written, rather
    // than waiting for a later 404/lazy-lookup to notice.
    let sessionChanged = false
    if (session.s3_settings_negative_cache_at !== undefined) {
      session.s3_settings_negative_cache_at = undefined
      sessionChanged = true
    }
    if (session.s3_settings_file_id !== meta.id) {
      session.s3_settings_file_id = meta.id
      sessionChanged = true
    }
    if (sessionChanged) {
      await saveSession(sessionId, session, context.env)
    }

    // A plain settings save has always implicitly reset sync status — it used to be
    // an accidental side effect of overwriting the one shared file with a body that
    // never carried status fields (see useS3Backfill.ts's clearSyncError and
    // SettingsModal.tsx's handleS3Save). Now that config and status are separate
    // files, do the same reset explicitly instead.
    let statusFileId = existing?.statusFileId ?? null
    try {
      const statusMeta = await writeJsonFile(accessToken, folderId, S3_SYNC_STATUS_FILE_NAME, {}, statusFileId ?? undefined)
      statusFileId = statusMeta.id
    } catch (e) {
      console.error('s3/settings.ts: failed to clear sync status after settings save', e)
    }

    // Mirror every existing entry the first time backup is enabled — otherwise only
    // entries saved/deleted after this point would ever reach the bucket.
    // Uses chunkSize so the backfill completes within Cloudflare's execution timeout;
    // the client's polling loop will call /api/s3/backfill-continue for the rest.
    //
    // Workflow settings saves preserve same-target history, reset a changed
    // target, and carry a durable backfill-required marker until startup succeeds.
    let startedJobId: string | undefined
    const bucketChanged = !!existing && existing.config.bucket !== body.bucket
    const needsFreshBackfill = workflowSave?.needsBackfill ?? (config.enabled && (!previouslyEnabled || bucketChanged))
    if (needsFreshBackfill && context.env.S3_WORKFLOW_SERVICE && session.google_sub) {
      try {
        const result = await context.env.S3_WORKFLOW_SERVICE.startBackfill({
          sessionId,
          accountKey: session.google_sub,
          requestId: context.request.headers.get('X-Request-ID') ?? crypto.randomUUID(),
        })
        startedJobId = result.job.jobId
      } catch (e) {
        const message = e instanceof Error ? e.message : ''
        if (message.includes('already running')) return jsonResponse({ error: message }, 409)
        console.error('s3/settings.ts: failed to start Workflow backfill', e)
        return jsonResponse({ error: 'Settings saved, but backfill could not be started' }, 502)
      }
    } else if (needsFreshBackfill) {
      const alreadyRunning = isBackfillRunActive(existing?.status.backfillProgress)
      if (!alreadyRunning) {
        const record: S3SettingsRecord = { config, status: {}, folderId, configFileId: meta.id, statusFileId }
        context.waitUntil(backfillAllEntries(accessToken, sessionId, session, context.env, record, undefined, 'Initial backfill', 20))
      }
    }

    return startedJobId
      ? jsonResponse({ ...meta, jobId: startedJobId }, 202)
      : jsonResponse(meta)
  } catch (e) {
    if (e instanceof Error && e.message.includes('already running')) return jsonResponse({ error: e.message }, 409)
    console.error('s3/settings.ts: PUT failed', e)
    return jsonResponse({ error: 'Internal server error' }, 500)
  }
}
