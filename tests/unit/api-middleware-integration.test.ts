import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { onRequest as apiMiddleware } from '../../functions/api/_middleware'
import { onRequestGet as onGetEntry } from '../../functions/api/drive/entry/[date]'
import * as drive from '../../functions/_shared/drive'
import { createFakeKV, type FakeKV } from '../helpers/fakeKV'

// Every other test in this suite calls one layer (middleware or a route handler)
// in isolation, hand-building whatever `context.data`/`context.env` that layer
// expects. That leaves the *contract between* layers unverified — if the
// middleware ever stopped setting `context.data.accessToken`, or the handler
// started reading a differently-named field, every isolated test above would
// keep passing while the real request chain broke. These tests instead compose
// the real middleware with a real route handler, sharing one context object and
// a real (in-memory) KV, exactly as Cloudflare Pages wires `_middleware.ts` to
// the leaf handler via `context.next()`.

vi.mock('../../functions/_shared/drive', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../functions/_shared/drive')>()),
  findEntryMeta: vi.fn().mockResolvedValue({ id: 'entry-1', name: 'diary-2026-05-01.json', version: '7' }),
  getEntryContent: vi.fn().mockResolvedValue({ date: '2026-05-01', content: 'hello from Drive', updated_at: '2026-05-01T00:00:00.000Z' }),
}))

function makeSession(overrides?: Record<string, unknown>) {
  return {
    refresh_token: 'rt',
    access_token: 'at-123',
    expires_at: Date.now() + 3600_000,
    ...overrides,
  }
}

function makeEnv(kv: FakeKV) {
  return {
    SESSIONS: kv,
    GOOGLE_CLIENT_ID: 'client-id',
    GOOGLE_CLIENT_SECRET: 'client-secret',
    SESSION_DOMAIN: 'https://example.com',
  }
}

// Chains api/_middleware.ts to the GET entry/[date] handler via a single shared
// context, the same object both layers read/write in production.
function makeChainedContext(request: Request, env: ReturnType<typeof makeEnv>, params: Record<string, string>) {
  const context: Record<string, unknown> = {
    request,
    env,
    params,
    data: {},
    waitUntil: vi.fn(),
  }
  context.next = vi.fn(() => onGetEntry(context as never))
  return context as { next: ReturnType<typeof vi.fn> } & Record<string, unknown>
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-05-01T12:00:00.000Z'))
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('api/_middleware.ts + drive/entry/[date].ts — real wiring', () => {
  it('threads sessionId/accessToken from middleware into the handler and returns the entry', async () => {
    const kv = createFakeKV({ 'session:sid123': JSON.stringify(makeSession()) })
    const env = makeEnv(kv)
    const request = new Request('http://localhost/api/drive/entry/2026-05-01', {
      headers: { Cookie: 'linger_session=sid123' },
    })
    const context = makeChainedContext(request, env, { date: '2026-05-01' })

    const response = await apiMiddleware(context as never)

    expect(response.status).toBe(200)
    expect(context.next).toHaveBeenCalledOnce()
    // The handler actually ran with the accessToken the middleware resolved from KV,
    // not a hardcoded test double — proves the data handoff, not just that *a*
    // response came back.
    expect(vi.mocked(drive.findEntryMeta)).toHaveBeenCalledWith(
      'at-123', 'sid123', expect.objectContaining({ access_token: 'at-123' }), env, '2026-05-01',
    )
    const body = await response.json() as { entry: { content: string } }
    expect(body.entry.content).toBe('hello from Drive')
    // Middleware's own post-processing (cookie renewal) still ran on the response
    // the handler produced — the two layers' effects compose, not one replacing
    // the other.
    expect(response.headers.get('Set-Cookie')).toContain('linger_session=sid123')
    expect(kv.has('session:sid123')).toBe(true)
  })

  it('blocks the handler entirely when there is no session cookie', async () => {
    const kv = createFakeKV()
    const env = makeEnv(kv)
    const request = new Request('http://localhost/api/drive/entry/2026-05-01')
    const context = makeChainedContext(request, env, { date: '2026-05-01' })

    const response = await apiMiddleware(context as never)

    expect(response.status).toBe(401)
    expect(context.next).not.toHaveBeenCalled()
    expect(vi.mocked(drive.findEntryMeta)).not.toHaveBeenCalled()
  })

  it('blocks the handler and deletes the session from KV when the refresh_token is dead', async () => {
    const kv = createFakeKV({
      'session:sid123': JSON.stringify(makeSession({ expires_at: Date.now() - 60_000 })),
    })
    const env = makeEnv(kv)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    ))
    const request = new Request('http://localhost/api/drive/entry/2026-05-01', {
      headers: { Cookie: 'linger_session=sid123' },
    })
    const context = makeChainedContext(request, env, { date: '2026-05-01' })

    const response = await apiMiddleware(context as never)

    expect(response.status).toBe(401)
    expect(context.next).not.toHaveBeenCalled()
    expect(vi.mocked(drive.findEntryMeta)).not.toHaveBeenCalled()
    // Real KV state, not just "delete() was called with this key" — the record
    // is actually gone from the store.
    expect(kv.has('session:sid123')).toBe(false)
  })
})
