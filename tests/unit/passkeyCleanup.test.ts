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
})
