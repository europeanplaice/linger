import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { createPasskeySession, saveD1Session } from '../../functions/_shared/authStore'
import type { Env, SessionData } from '../../functions/_shared/session'
import { encodeVaultBytes } from '../../functions/_shared/vaultCrypto'
import { createFakeKV } from './fakeKV'

// The unit-test adapter executes real SQL and the actual migration chain. Worker
// runtime tests independently exercise Cloudflare's real D1 binding.
export function sqliteD1(db: DatabaseSync): D1Database {
  const prepare = (sql: string) => {
    let values: (string | number | null | Uint8Array)[] = []
    const statement = {
      bind(...params: typeof values) { values = params; return statement },
      async first(column?: string) {
        const row = db.prepare(sql).get(...values)
        return column ? row?.[column] ?? null : row ?? null
      },
      async all() { return { success: true, results: db.prepare(sql).all(...values), meta: {} } },
      async run() {
        const result = db.prepare(sql).run(...values)
        return { success: true, results: [], meta: { changes: Number(result.changes) } }
      },
      async raw() { return db.prepare(sql).all(...values).map(row => Object.values(row)) },
    }
    return statement
  }
  return {
    prepare,
    async batch(statements: { all(): Promise<unknown> }[]) {
      db.exec('BEGIN')
      try {
        const results = []
        for (const statement of statements) results.push(await statement.all())
        db.exec('COMMIT')
        return results
      } catch (error) { db.exec('ROLLBACK'); throw error }
    },
    async exec(sql: string) { db.exec(sql); return { count: 1, duration: 0 } },
  } as never
}

export async function createPasskeyTestEnv(
  session: SessionData = {},
  options: { sessionId?: string; userId?: string; domain?: string; clientId?: string } = {},
) {
  const db = new DatabaseSync(':memory:')
  for (const name of readdirSync('migrations/auth').filter(name => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(`migrations/auth/${name}`, 'utf8'))
  }
  const userId = options.userId ?? crypto.randomUUID()
  const sessionId = options.sessionId ?? 'sid123'
  const key = encodeVaultBytes(crypto.getRandomValues(new Uint8Array(32)))
  const kv = createFakeKV()
  const env: Env = {
    AUTH_DB: sqliteD1(db), SESSIONS: kv as never,
    GOOGLE_CLIENT_ID: options.clientId ?? 'client-id', GOOGLE_CLIENT_SECRET: 'test-client-secret',
    SESSION_DOMAIN: options.domain ?? 'https://example.com',
  }
  db.prepare('INSERT INTO passkey_users (id, created_at) VALUES (?, ?)').run(userId, Date.now())
  await createPasskeySession(sessionId, userId, env)
  await saveD1Session(sessionId, { ...session, user_id: userId, vault_key: key }, { ...env, AUTH_DB: env.AUTH_DB! })
  const headers = {
    Cookie: `linger_session=${sessionId}`,
    'X-Linger-Vault-Key': key,
    'X-Linger-Vault-User': userId,
    ...(session.google_sub ? { 'X-Linger-Account': `sub:${session.google_sub}` } : {}),
  }
  return { env, db, headers, key, userId, sessionId, kv }
}
