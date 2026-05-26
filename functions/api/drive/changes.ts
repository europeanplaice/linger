import type { Env, Data } from '../../_shared/session'
import { jsonResponse, saveSession } from '../../_shared/session'
import { getStartPageToken, getChanges, DriveError } from '../../_shared/drive'

export const onRequestGet: PagesFunction<Env, string, Data> = async (context) => {
  const { accessToken, sessionId, session } = context.data
  if (!session) return jsonResponse({ error: 'Unauthorized' }, 401)

  try {
    const stored = session.changes_start_page_token

    // No stored token yet: initialise it and signal the client to do a full
    // refresh (which happens on sign-in) by returning no changes.
    if (!stored) {
      const newStartPageToken = await getStartPageToken(accessToken)
      session.changes_start_page_token = newStartPageToken
      await saveSession(sessionId, { ...session, changes_start_page_token: newStartPageToken }, context.env)
      return jsonResponse({ changes: [], newStartPageToken })
    }

    try {
      const result = await getChanges(accessToken, stored)
      session.changes_start_page_token = result.newStartPageToken
      await saveSession(sessionId, { ...session, changes_start_page_token: result.newStartPageToken }, context.env)
      return jsonResponse(result)
    } catch (e) {
      // A stale/invalid page token returns 400 or 404. Reset by fetching a
      // fresh token and return empty changes; the client will full-refresh next.
      if (e instanceof DriveError && (e.status === 400 || e.status === 404)) {
        const newStartPageToken = await getStartPageToken(accessToken)
        session.changes_start_page_token = newStartPageToken
        await saveSession(sessionId, { ...session, changes_start_page_token: newStartPageToken }, context.env)
        return jsonResponse({ changes: [], newStartPageToken })
      }
      throw e
    }
  } catch (e) {
    const status = (e instanceof Error && 'status' in e) ? (e as { status: number }).status : 500
    console.error('changes.ts: Failed to get changes', e)
    return jsonResponse({ error: 'Internal server error' }, status)
  }
}
