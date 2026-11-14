import type { Env, Data } from '../../../_shared/session'
import { forwardS3Backup } from '../../../_shared/s3BackupRequest'
import { jsonResponse } from '../../../_shared/session'

export const onRequestPost: PagesFunction<Env, 'date', Data> = context => {
  const date = context.params.date as string
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return jsonResponse({ error: 'Invalid date' }, 400)
  return forwardS3Backup(context, { kind: 'reconcile', date })
}
