import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import type { MirrorWorkflowParams, WorkflowEnv } from './types'
import { countedStep, deleteEntryCore, indexFor, isPermanentEntryError, mirrorEntryCore, safeError } from './runtime'

// Steps that only touch the Durable Object / Workflow-binding (not the external
// Drive/S3 subrequest budget) can retry generously — those calls don't compete
// with the pooled, never-resets-mid-instance subrequest limit. Same rationale as
// workflow.ts's BOOKKEEPING_STEP_RETRIES.
const BOOKKEEPING_STEP_RETRIES = { limit: 3, delay: '5 seconds' as const, backoff: 'exponential' as const }
// The mirror step spends external Drive/S3/STS subrequests and gets only one
// retry: the subrequest budget is pooled across the whole Workflow instance, so
// retrying a step that failed from exhausting that budget only guarantees it
// fails again, burning further steps (and daily step budget) for no chance of
// success — see workflow.ts's EXTERNAL_STEP_RETRIES.
const EXTERNAL_STEP_RETRIES = { limit: 1, delay: '5 seconds' as const, backoff: 'exponential' as const }
const STEP_TIMEOUT = '2 minutes' as const

interface MirrorStepResult {
  ok: boolean
  error?: string
}

// Mirrors (or removes) exactly one diary date to/from the user's S3 bucket.
// Created fire-and-forget by the mirrorEntry/deleteEntry RPCs (see runtime.ts)
// so a save endpoint's context.waitUntil never races a long mirror against its
// 30-second budget; the real Drive→S3 work happens here, where each step's
// retry config absorbs the transient Drive/STS/S3 failures that previously
// failed a save's mirror outright on the first (only) attempt.
export class S3MirrorWorkflow extends WorkflowEntrypoint<WorkflowEnv, MirrorWorkflowParams> {
  async run(event: WorkflowEvent<MirrorWorkflowParams>, step: WorkflowStep): Promise<void> {
    const params = event.payload
    const index = indexFor(this.env, params.accountKey)
    const kind = params.kind

    await countedStep(this.env, step, `mark-pending-${kind}`, { retries: BOOKKEEPING_STEP_RETRIES, timeout: STEP_TIMEOUT }, async () => {
      await index.markPending(params.date, kind === 'delete' ? undefined : params.driveVersion, new Date().toISOString())
      return null
    })

    const result = await countedStep<MirrorStepResult>(
      this.env,
      step,
      `${kind}-entry`,
      { retries: EXTERNAL_STEP_RETRIES, timeout: STEP_TIMEOUT },
      async () => {
        try {
          if (kind === 'delete') await deleteEntryCore(this.env, index, params)
          else await mirrorEntryCore(this.env, index, params)
          return { ok: true }
        } catch (error) {
          // A definitive, entry-specific 4xx (bad request, genuinely forbidden, …)
          // will never succeed on retry — record it and end the step successfully
          // rather than burning the step's retries (and the account's step budget)
          // on it. Anything else (network blip, Drive 5xx/quota, STS throttling,
          // token expiry) is rethrown so the step's configured retry re-runs the
          // whole idempotent mirror — the resilience a single un-retried attempt
          // lacked before this workflow existed.
          if (isPermanentEntryError(error)) {
            const message = safeError(error)
            await index.markFailed(params.date, params.driveVersion, message, new Date().toISOString())
            return { ok: false, error: message }
          }
          throw error
        }
      },
    )

    if (!result.ok) console.warn(`S3 ${kind} for ${params.date} failed permanently:`, result.error)
  }
}
