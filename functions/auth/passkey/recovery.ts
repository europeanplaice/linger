import { retirePreviousPasskeyAccounts } from '../../_shared/authStore'
import { getSession, jsonResponse, parseSessionId, validateMutationOrigin, type Env } from '../../_shared/session'

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const rejected = validateMutationOrigin(request, env)
  if (rejected) return rejected

  const id = parseSessionId(request)
  if (!id || !env.AUTH_DB) return jsonResponse({ error: 'Passkey session required' }, 401)
  try {
    const key = request.headers.get('X-Linger-Vault-Key') ?? undefined
    const session = await getSession(id, env, key)
    if (!session?.user_id || !session.google_sub || session.user_id !== request.headers.get('X-Linger-Vault-User')) {
      return jsonResponse({ error: 'Linked passkey session required' }, 401)
    }

    const revokedPasskeys = await retirePreviousPasskeyAccounts(id, session.user_id, session.google_sub, { ...env, AUTH_DB: env.AUTH_DB })
    return revokedPasskeys === null
      ? jsonResponse({ error: 'A fresh Google confirmation and a saved Google connection are required' }, 409)
      : jsonResponse({ revokedPasskeys })
  } catch {
    return jsonResponse({ error: 'Passkey recovery temporarily unavailable' }, 503)
  }
}
