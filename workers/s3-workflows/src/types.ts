// Derived from the `wrangler types`-generated worker-configuration.d.ts (the
// single source of truth for the Worker's bindings) instead of a hand-written
// binding list, so regenerating types after a binding change stays consistent.
// The global `Cloudflare.Env` includes AUTH_DB, legacy/cache KV, secrets, S3_SYNC_INDEX /
// workflow bindings this Worker is configured with. (An empty `extends`
// interface would trip no-empty-object-type, and the alias keeps us equally
// insulated from worker-configuration.d.ts changes.)
export type WorkflowEnv = Cloudflare.Env

export interface DiaryTarget {
  date: string
  version?: string
}

export interface S3BackfillParams {
  sessionId: string
  accountKey: string
  jobId: string
  // Scope contains only dates and Drive versions. Drive file IDs and S3
  // configuration are intentionally reconstructed during request-scoped work.
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
export interface MirrorWorkflowParams {
  sessionId: string
  accountKey: string
  date: string
  driveVersion?: string
  jobId?: string
  deletionId?: string
  kind: 'mirror' | 'delete'
}
