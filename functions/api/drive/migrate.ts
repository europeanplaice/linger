import type { Env, Data } from '../../_shared/session'
import { jsonResponse } from '../../_shared/session'
import { migrateMdToTxt } from '../../_shared/drive'

// One-time migration endpoint: renames legacy `.md` diary files to `.txt`.
// Idempotent and safe to call repeatedly; returns the number of files renamed.
export const onRequestPost: PagesFunction<Env, string, Data> = async (context) => {
  const { accessToken, sessionId, session } = context.data
  if (!session) return jsonResponse({ error: 'Unauthorized' }, 401)

  try {
    const migrated = await migrateMdToTxt(accessToken, sessionId, session, context.env)
    return jsonResponse({ migrated })
  } catch (e) {
    console.error('migrate.ts: Failed to migrate entries', e)
    return jsonResponse({ error: 'Internal error' }, 500)
  }
}
