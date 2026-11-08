import type { Env } from '../_shared/session'
import { getPasskeySessionUserId } from '../_shared/authStore'
import { parseSessionId, getSession, validateRequestAccount, invalidateSession, clearSessionCookie, validateMutationOrigin, jsonResponse } from '../_shared/session'

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const originError = validateMutationOrigin(request, env)
  if (originError) return originError

  const sessionId = parseSessionId(request)
  if (sessionId) {
    const userId = await getPasskeySessionUserId(sessionId, env)
    // A stale tab must not revoke a different passkey account's cookie.
    if (!userId) return jsonResponse({ ok: true })
    if (userId !== request.headers.get('X-Linger-Vault-User')) return jsonResponse({ error: 'Account changed' }, 401)
    const session = await getSession(sessionId, env, request.headers.get('X-Linger-Vault-Key') ?? undefined)
    if (session?.google_sub && request.headers.has('X-Linger-Account')) {
      const accountError = validateRequestAccount(request, session)
      if (accountError) return accountError
    }
    await invalidateSession(sessionId, undefined, env)
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': clearSessionCookie(!env.SESSION_DOMAIN.startsWith('http://')),
    },
  })
}
