import { describe, expect, it, vi } from 'vitest'
import { cleanupAuth } from '../../functions/_shared/authStore'
import { createPasskeyTestEnv } from '../helpers/passkeyAuth'

describe('retired KV auth data cleanup', () => {
  it('deletes old identity/session/OAuth keys in bounded pages without reading payloads', async () => {
    const { env, db } = await createPasskeyTestEnv()
    const names = [
      'session:old-user',
      'ssidx:raw-google-sub:old-user',
      'esidx:user@example.com:old-user',
      'oauth_state:old-state',
    ]
    const get = vi.fn(async (name: string) => name.startsWith('legacy_') ? null : null)
    const deleted = vi.fn(async (name: string) => { void name })
    const listed = vi.fn(async ({ prefix }: { prefix: string; limit: number; cursor?: string }) => ({
      keys: names.filter(name => name.startsWith(prefix)).map(name => ({ name })),
      list_complete: true,
    }))
    env.SESSIONS = { get, delete: deleted, list: listed, put: vi.fn() } as never

    await cleanupAuth(env as never)

    const removed = new Set(deleted.mock.calls.map(call => call[0]))
    for (const name of names) expect(removed.has(name)).toBe(true)
    expect(listed).toHaveBeenCalledWith(expect.objectContaining({ prefix: 'session:', limit: 500 }))
    expect(listed).toHaveBeenCalledWith(expect.objectContaining({ prefix: 'ssidx:', limit: 500 }))
    expect(listed).toHaveBeenCalledWith(expect.objectContaining({ prefix: 'esidx:', limit: 500 }))
    expect(listed).toHaveBeenCalledWith(expect.objectContaining({ prefix: 'oauth_state:', limit: 500 }))
    expect(get.mock.calls.every(([name]) => String(name).startsWith('legacy_'))).toBe(true)
    db.close()
  })

  it('prunes expired D1 challenges, management grants, RISC replay records, and rate limits while keeping unexpired rows', async () => {
    const { env, db } = await createPasskeyTestEnv()
    env.SESSIONS = {
      get: vi.fn().mockResolvedValue(null),
      delete: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
      put: vi.fn().mockResolvedValue(undefined),
    } as never
    try {
      const now = Date.now()
      const past = now - 10_000
      const future = now + 60_000

      db.prepare('INSERT INTO auth_oauth_states (id, data, expires_at) VALUES (?, ?, ?)').run('expired-oauth', '{}', past)
      db.prepare('INSERT INTO auth_oauth_states (id, data, expires_at) VALUES (?, ?, ?)').run('live-oauth', '{}', future)

      db.prepare('INSERT INTO auth_sessions (id, user_id, data, expires_at) VALUES (?, NULL, NULL, ?)').run('expired-session', past)
      db.prepare('INSERT INTO auth_sessions (id, user_id, data, expires_at) VALUES (?, NULL, NULL, ?)').run('live-session', future)

      db.prepare('INSERT INTO passkey_challenges (id, challenge, wrap_challenge, purpose, expires_at) VALUES (?, ?, ?, ?, ?)')
        .run('expired-challenge', 'c1', 'w1', 'login', past)
      db.prepare('INSERT INTO passkey_challenges (id, challenge, wrap_challenge, purpose, expires_at) VALUES (?, ?, ?, ?, ?)')
        .run('live-challenge', 'c2', 'w2', 'login', future)

      db.prepare('INSERT INTO passkey_management_grants (session_id, action, expires_at) VALUES (?, ?, ?)')
        .run('expired-grant', 'add', past)
      db.prepare('INSERT INTO passkey_management_grants (session_id, action, expires_at) VALUES (?, ?, ?)')
        .run('live-grant', 'delete', future)

      db.prepare('INSERT INTO risc_processed_events (jti_hash, expires_at) VALUES (?, ?)').run('sha256:expired', past)
      db.prepare('INSERT INTO risc_processed_events (jti_hash, expires_at) VALUES (?, ?)').run('sha256:live', future)

      db.prepare('INSERT INTO auth_rate_limits (bucket_key, count, expires_at) VALUES (?, ?, ?)').run('hmac-sha256:expired', 5, past)
      db.prepare('INSERT INTO auth_rate_limits (bucket_key, count, expires_at) VALUES (?, ?, ?)').run('hmac-sha256:live', 2, future)

      await cleanupAuth(env as never)

      expect(db.prepare('SELECT id FROM auth_oauth_states').all()).toEqual([{ id: 'live-oauth' }])
      expect(db.prepare('SELECT id FROM auth_sessions WHERE id IN (?, ?)').all('expired-session', 'live-session')).toEqual([{ id: 'live-session' }])
      expect(db.prepare('SELECT id FROM passkey_challenges').all()).toEqual([{ id: 'live-challenge' }])
      expect(db.prepare('SELECT session_id FROM passkey_management_grants').all()).toEqual([{ session_id: 'live-grant' }])
      expect(db.prepare('SELECT jti_hash FROM risc_processed_events').all()).toEqual([{ jti_hash: 'sha256:live' }])
      expect(db.prepare('SELECT bucket_key FROM auth_rate_limits').all()).toEqual([{ bucket_key: 'hmac-sha256:live' }])
    } finally {
      db.close()
    }
  })
})
