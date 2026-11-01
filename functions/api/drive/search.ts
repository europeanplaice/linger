import type { Env, Data } from '../../_shared/session'
import { jsonResponse } from '../../_shared/session'
import { searchEntries } from '../../_shared/drive'

export const onRequestPost: PagesFunction<Env, string, Data> = async (context) => {
  const { accessToken, sessionId, session } = context.data
  let body: unknown
  try { body = await context.request.json() } catch { return jsonResponse({ error: 'Invalid JSON' }, 400) }
  const query = typeof body === 'object' && body !== null && 'query' in body && typeof body.query === 'string' ? body.query : ''
  if (!query.trim()) return jsonResponse({ files: [] })
  if (query.length > 500) return jsonResponse({ files: [] })

  if (!session) return jsonResponse({ error: 'Unauthorized' }, 401)

  try {
    const files = await searchEntries(accessToken, sessionId, session, context.env, query)
    return jsonResponse({ files })
  } catch (e) {
    const status = (e instanceof Error && 'status' in e) ? (e as { status: number }).status : 500
    console.error('search.ts: Failed to search entries')
    return jsonResponse({ error: 'Internal server error' }, status)
  }
}
