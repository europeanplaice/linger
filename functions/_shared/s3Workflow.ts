export type S3SyncState = 'pending' | 'synced' | 'failed' | 'unknown'

export interface EntrySyncStatus {
  date: string
  driveVersion?: string
  syncedVersion?: string
  state: S3SyncState
  updatedAt: string
  lastError?: string
}

export type BackfillJobState = 'queued' | 'running' | 'complete' | 'failed' | 'cancelled'

export interface BackfillJob {
  jobId: string
  state: BackfillJobState
  total: number
  completed: number
  failed: number
  failedDates: string[]
  startedAt: string
  finishedAt?: string
  workflowId: string
  error?: string
}

export interface S3WorkflowAuth {
  sessionId: string
  accountKey: string
}

export interface StartBackfillInput extends S3WorkflowAuth {
  requestId: string
  scope?: string[]
}

export interface StartBackfillResult {
  job: BackfillJob
  created: boolean
}

export interface GetJobInput extends S3WorkflowAuth {
  jobId?: string
}

export interface GetEntryStatusInput extends S3WorkflowAuth {
  date: string
  requestedVersion: string
  since?: string
}

export interface SetBackupEnabledInput extends S3WorkflowAuth {
  enabled: boolean
  resetEntries?: boolean
}

export type PublicEntryStatus = 'synced' | 'pending' | 'failed' | 'unconfirmed' | 'disabled'

export interface EntryStatusResult {
  status: PublicEntryStatus
  error?: string
}

export interface MirrorEntryInput extends S3WorkflowAuth {
  date: string
  fileId?: string
  driveVersion?: string
}

export interface DeleteEntryInput extends S3WorkflowAuth {
  date: string
}

export interface MirrorResult {
  ok: boolean
  error?: string
}

/** RPC surface exposed by the dedicated Workflow Worker. */
export interface S3WorkflowService {
  startBackfill(input: StartBackfillInput): Promise<StartBackfillResult>
  getJob(input: GetJobInput): Promise<BackfillJob | null>
  getEntryStatus(input: GetEntryStatusInput): Promise<EntryStatusResult>
  setBackupEnabled(input: SetBackupEnabledInput): Promise<void>
  mirrorEntry(input: MirrorEntryInput): Promise<MirrorResult>
  deleteEntry(input: DeleteEntryInput): Promise<MirrorResult>
}
