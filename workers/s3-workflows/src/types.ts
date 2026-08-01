import type { Env as PagesEnv } from '../../../functions/_shared/session'
import type { S3SyncIndex } from './syncIndex'

export interface WorkflowEnv extends PagesEnv {
  S3_BACKFILL_WORKFLOW: Workflow<S3BackfillParams>
  S3_SYNC_INDEX: DurableObjectNamespace<S3SyncIndex>
}

import type { S3Config } from './runtime'

export interface S3BackfillParams {
  sessionId: string
  accountKey: string
  jobId: string
  config?: S3Config
  scope?: string[]
}

export interface DiaryTarget {
  date: string
  fileId: string
  version?: string
}

export interface EntryProcessResult {
  processed: number
  failedDates: string[]
}

export interface EntryPage {
  entries: DiaryTarget[]
  nextPageToken?: string
}
