import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import { NonRetryableError } from 'cloudflare:workflows'
import type { MirrorWorkflowParams, WorkflowEnv } from './types'

// Old durable mirrors cannot carry the vault key needed to protect metadata.
// A fresh authenticated request reconciles the entry instead.
export class S3MirrorWorkflow extends WorkflowEntrypoint<WorkflowEnv, MirrorWorkflowParams> {
  async run(_event: WorkflowEvent<MirrorWorkflowParams>, _step: WorkflowStep): Promise<void> {
    throw new NonRetryableError('Background mirroring is retired; retry from the open application')
  }
}
