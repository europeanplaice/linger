import { encodeVaultBytes } from '../../../functions/_shared/vaultCrypto'
import { createSession } from '../../../functions/_shared/session'
import type { SessionData } from '../../../functions/_shared/session'
import type { Env } from '../../../functions/_shared/session'

export function vaultKey(): string {
  return encodeVaultBytes(crypto.getRandomValues(new Uint8Array(32)))
}

export function testSession(userId: string, extra: Partial<SessionData> = {}): SessionData {
  return {
    user_id: userId,
    vault_key: vaultKey(),
    google_sub: `google-sub-${crypto.randomUUID()}`,
    expires_at: Date.now() + 3_600_000,
    access_token: 'test-access-token',
    id_token: 'test-id-token',
    id_token_verified: true,
    ...extra,
  }
}

export async function createTestSession(sessionId: string, session: SessionData, env: Env): Promise<void> {
  if (!session.user_id) throw new Error('Test session needs a random user_id')
  await env.AUTH_DB!.prepare('INSERT OR IGNORE INTO passkey_users (id, created_at) VALUES (?, ?)')
    .bind(session.user_id, Date.now()).run()
  await createSession(sessionId, session, env)
}
