import type { Env, Data } from '../../_shared/session'
import { jsonResponse, saveSession } from '../../_shared/session'
import { listEntries, getStartPageToken } from '../../_shared/drive'

export const onRequestGet: PagesFunction<Env, string, Data> = async (context) => {
  const { accessToken, sessionId, session } = context.data
  if (!session) return jsonResponse({ error: 'Unauthorized' }, 401)

  try {
    const [files, startPageToken] = await Promise.all([
      listEntries(accessToken, sessionId, session, context.env),
      getStartPageToken(accessToken).catch(() => null),
    ])

    // Persist the changes API baseline so the next incremental sync is
    // relative to the state just observed here without blocking the response.
    if (startPageToken && startPageToken !== session.changes_start_page_token) {
      session.changes_start_page_token = startPageToken
      const saving = saveSession(sessionId, { ...session, changes_start_page_token: startPageToken }, context.env).catch(() => {
        console.error('entries.ts: Failed to refresh changes start page token')
      })
      if (typeof context.waitUntil === 'function') context.waitUntil(saving)
      else await saving
    }

    return jsonResponse({ files })
  } catch (e) {
    const status = (e instanceof Error && 'status' in e) ? (e as { status: number }).status : 500
    console.error('entries.ts: Failed to list entries')
    return jsonResponse({ error: 'Internal server error' }, status)
  }
}
