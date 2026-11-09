import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import { NonRetryableError } from 'cloudflare:workflows'
import type { S3BackfillParams, WorkflowEnv } from './types'

// Existing instances can resume after deployment. They have no request-scoped
// vault key, and their payloads and checkpoints may contain dates, so never
// resume their old code or create successor instances. Backfill is now driven
// by authenticated browser requests.
export class S3BackfillWorkflow extends WorkflowEntrypoint<WorkflowEnv, S3BackfillParams> {
  async run(_event: WorkflowEvent<S3BackfillParams>, _step: WorkflowStep): Promise<void> {
    throw new NonRetryableError('Background backup is retired; continue from the open application')
  }
}
