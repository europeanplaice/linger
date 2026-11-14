import type { Data, Env } from './session'
import { jsonResponse } from './session'
import type { S3BackupOperation } from './s3Workflow'

type BackupContext = { data: Data; env: Env }

// Every mutation enters the same account DO. Never fall back to uncoordinated
// writes when the service is missing or fails.
export async function forwardS3Backup(context: BackupContext, operation: S3BackupOperation): Promise<Response> {
  const { session, sessionId, accessToken, idToken } = context.data
  if (!session) return jsonResponse({ error: 'Unauthorized' }, 401)
  if (!session.user_id) return jsonResponse({ error: 'Please sign in again' }, 401)
  try {
    const coordinator = context.env.S3_WORKFLOW_SERVICE ?? context.env.S3_SYNC_INDEX?.getByName(session.user_id)
    if (!coordinator) return jsonResponse({ error: 'Backup coordinator unavailable' }, 503)
    return await coordinator.backup({
      sessionId, accountKey: session.user_id, vaultKey: session.vault_key,
      accessToken, expiresAt: session.expires_at, idToken: idToken ?? session.id_token, operation,
    })
  } catch {
    return jsonResponse({ error: 'Backup coordinator unavailable' }, 503)
  }
}
