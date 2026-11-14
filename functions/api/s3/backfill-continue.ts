import type { Env, Data } from '../../_shared/session'
import { forwardS3Backup } from '../../_shared/s3BackupRequest'

export const onRequestPost: PagesFunction<Env, string, Data> = context =>
  forwardS3Backup(context, { kind: 'continue' })
