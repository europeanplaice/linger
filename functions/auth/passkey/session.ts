import { getSession, parseSessionId, jsonResponse, type Env } from '../../_shared/session'

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const id = parseSessionId(request)
  const userId = request.headers.get('X-Linger-Vault-User')
  const key = request.headers.get('X-Linger-Vault-Key') ?? undefined
  const session = id ? await getSession(id, env, key) : null
  if (!userId || session?.user_id !== userId) return jsonResponse({ error: 'Unauthorized' }, 401, { 'Cache-Control': 'no-store' })
  return jsonResponse({ valid: true }, 200, { 'Cache-Control': 'no-store' })
}
