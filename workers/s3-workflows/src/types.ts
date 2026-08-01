import type { Env as PagesEnv } from '../../../functions/_shared/session'
import type { MirrorEntryCoreInput } from './runtime'
import type { S3SyncIndex } from './syncIndex'

export interface WorkflowEnv extends PagesEnv {
  S3_BACKFILL_WORKFLOW: Workflow<S3BackfillParams>
  S3_MIRROR_WORKFLOW: Workflow<MirrorWorkflowParams>
  S3_SYNC_INDEX: DurableObjectNamespace<S3SyncIndex>
}

import type { S3Config } from './runtime'

export interface DiaryTarget {
  date: string
  fileId?: string
  version?: string
}

export interface S3BackfillParams {
  sessionId: string
  accountKey: string
  jobId: string
  config?: S3Config
  // Carries whatever fileId/version a prior discovery/listing step already learned
  // (see workflow.ts's discovery branch and workerFirstPass.ts) so a chunk-chained
  // or first-pass-deferred continuation never has to re-search Drive by name for
  // an entry it already has a direct id for, and can skip already-synced entries
  // (matching against the DO index) without any Drive/S3 subrequest at all.
  scope?: DiaryTarget[]
  chunkIndex?: number
}

export interface EntryProcessResult {
  processed: number
  failedDates: string[]
}

export interface EntryPage {
  entries: DiaryTarget[]
  nextPageToken?: string
}

// Payload of a single-entry mirror/delete S3MirrorWorkflow instance (created
// fire-and-forget by the mirrorEntry/deleteEntry RPCs — see runtime.ts). One
// instance mirrors exactly one date; the mirror steps' retry config absorbs
// transient Drive/STS/S3 failures that used to fail a save's mirror outright.
export interface MirrorWorkflowParams extends MirrorEntryCoreInput {
  kind: 'mirror' | 'delete'
}
