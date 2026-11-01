import { env, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import { createSession, getSession, saveSession } from '../../../functions/_shared/session'
import type { SessionData } from '../../../functions/_shared/session'
import type { DiaryWriter } from '../src/diaryWriter'
import type { WorkflowEnv } from '../src/types'

vi.mock('../../../functions/_shared/drive', async importOriginal => ({
  ...await importOriginal<typeof import('../../../functions/_shared/drive')>(),
  ensureFolder: vi.fn(async (_token: string, _id: string, session: SessionData) => {
    session.folder_id = 'privacy-folder'
    return 'privacy-folder'
  }),
  getEntryMeta: vi.fn(async (_token: string, id: string) => ({
    id, name: 'linger_diary', mimeType: 'application/vnd.google-apps.folder',
  })),
}))

const sentinel = {
  access_token: 'privacy-access-sentinel',
  refresh_token: 'privacy-refresh-sentinel',
  id_token: 'privacy-id-sentinel',
  secretAccessKey: 'privacy-aws-secret-sentinel',
}

function authSession(extra: Partial<SessionData> = {}): SessionData {
  return {
    ...sentinel,
    expires_at: Date.now() + 3_600_000,
    id_token_verified: true,
    email: 'privacy@example.com',
    google_sub: `privacy-${crypto.randomUUID()}`,
    folder_id: 'folder-metadata',
    ...extra,
  }
}

function rawD1(row: unknown): string {
  return JSON.stringify(row)
}

describe('OAuth credential storage privacy', () => {
  it('persists only the typed metadata allowlist in D1 and returns no credentials', async () => {
    const id = `privacy-${crypto.randomUUID()}`
    const session = authSession()
    await createSession(id, session, env)

    const row = await env.AUTH_DB.prepare('SELECT data, email, google_sub, client_id FROM auth_sessions WHERE id = ?')
      .bind(id).first<Record<string, unknown>>()
    expect(row).not.toBeNull()
    const persisted = rawD1(row)
    for (const secret of Object.values(sentinel)) expect(persisted).not.toContain(secret)
    expect(persisted).not.toContain('expires_at')
    expect(JSON.parse(String(row!.data))).toMatchObject({
      folder_id: 'folder-metadata',
      email: 'privacy@example.com',
      google_sub: session.google_sub,
    })

    const loaded = await getSession(id, env)
    expect(loaded).toMatchObject({ folder_id: 'folder-metadata', google_sub: session.google_sub })
    for (const key of ['access_token', 'refresh_token', 'id_token', 'expires_at', 'id_token_verified']) {
      expect(loaded).not.toHaveProperty(key)
    }
  })

  it('keeps tokens out of D1 after a stale metadata writer saves', async () => {
    const id = `privacy-save-${crypto.randomUUID()}`
    const session = authSession()
    await createSession(id, session, env)
    session.folder_id = 'updated-folder'
    await saveSession(id, session, env)

    const row = await env.AUTH_DB.prepare('SELECT data FROM auth_sessions WHERE id = ?').bind(id).first<{ data: string }>()
    const persisted = rawD1(row)
    for (const secret of Object.values(sentinel)) expect(persisted).not.toContain(secret)
    expect(JSON.parse(row!.data)).toMatchObject({ folder_id: 'updated-folder' })
    expect(await getSession(id, env)).not.toHaveProperty('access_token')
  })

  it('rejects unknown, nested, and wrong-type fields at the D1 boundary', async () => {
    const id = `privacy-trigger-${crypto.randomUUID()}`
    const now = Date.now()
    const allowed = JSON.stringify({ google_sub: 'trigger-test' })
    const insert = (data: string) => env.AUTH_DB.prepare(
      'INSERT INTO auth_sessions (id, data, expires_at) VALUES (?, ?, ?)',
    ).bind(id, data, now + 60_000).run()

    await expect(insert(JSON.stringify({ google_sub: 'trigger-test', unexpected: 'secret' }))).rejects.toThrow()
    await expect(insert(JSON.stringify({ google_sub: 'trigger-test', nested: { token: 'secret' } }))).rejects.toThrow()
    await expect(insert(JSON.stringify({ google_sub: ['not', 'text'] }))).rejects.toThrow()

    await insert(allowed)
    await expect(env.AUTH_DB.prepare('UPDATE auth_sessions SET data = ? WHERE id = ?')
      .bind(JSON.stringify({ google_sub: 'trigger-test', future_secret: 'secret' }), id).run()).rejects.toThrow()
  })

  it('does not import credential-bearing legacy KV sessions into D1', async () => {
    const id = `privacy-legacy-${crypto.randomUUID()}`
    await env.SESSIONS.put(`session:${id}`, JSON.stringify(authSession()), { expirationTtl: 300 })

    expect(await getSession(id, env)).toBeNull()
    expect(await env.AUTH_DB.prepare('SELECT id FROM auth_sessions WHERE id = ?').bind(id).first()).toBeNull()
  })

  it('passes OAuth credentials transiently to DiaryWriter without persisting them in Durable Object storage', async () => {
    const accountKey = `privacy-do-${crypto.randomUUID()}`
    const sessionId = `privacy-do-session-${crypto.randomUUID()}`
    await createSession(sessionId, authSession({ google_sub: accountKey }), env)
    const workflowEnv = env as unknown as WorkflowEnv
    const writer = workflowEnv.DIARY_WRITER.getByName(accountKey)

    expect(await writer.ensureFolder({
      sessionId,
      accountKey,
      accessToken: sentinel.access_token,
      expiresAt: Date.now() + 3_600_000,
      idToken: sentinel.id_token,
    })).toBe('privacy-folder')

    const stored = await runInDurableObject(writer, async (_instance: DiaryWriter, state) =>
      Object.fromEntries(await state.storage.list()),
    )
    const persisted = rawD1(stored)
    for (const secret of Object.values(sentinel)) expect(persisted).not.toContain(secret)
    expect(stored).toEqual({ folder: 'privacy-folder' })
    const row = await env.AUTH_DB.prepare('SELECT data FROM auth_sessions WHERE id = ?').bind(sessionId).first<{ data: string }>()
    for (const secret of Object.values(sentinel)) expect(row!.data).not.toContain(secret)
  })
})
