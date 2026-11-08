import { createPasskeyTestEnv } from '../helpers/passkeyAuth'
import { getSession } from '../../functions/_shared/session'
import { getPasskeySessionUserId } from '../../functions/_shared/authStore'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { onRequest as apiMiddleware } from '../../functions/api/_middleware'
import { onRequestGet as onGetEntry, onRequestPost as onPostEntry } from '../../functions/api/drive/entry/[date]'
import { saveDiaryEntry } from '../../functions/_shared/entryMutation'
import * as drive from '../../functions/_shared/drive'
import { createFakeKV, type FakeKV } from '../helpers/fakeKV'

// Every other test in this suite calls one layer (middleware or a route handler)
// in isolation, hand-building whatever `context.data`/`context.env` that layer
// expects. That leaves the *contract between* layers unverified — if the
// middleware ever stopped setting `context.data.accessToken`, or the handler
// started reading a differently-named field, every isolated test above would
// keep passing while the real request chain broke. These tests instead compose
// the real middleware with a real route handler, sharing one context object and
// a migrated in-memory SQL database with encrypted metadata, exactly as Cloudflare Pages wires `_middleware.ts` to
// the leaf handler via `context.next()`.

vi.mock('../../functions/_shared/drive', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../functions/_shared/drive')>()),
  findEntryMeta: vi.fn().mockResolvedValue({ id: 'entry-1', name: 'diary-2026-05-01.json', version: '7' }),
  getEntryContent: vi.fn().mockResolvedValue({ date: '2026-05-01', content: 'hello from Drive', updated_at: '2026-05-01T00:00:00.000Z' }),
}))

function makeSession(overrides?: Record<string, unknown>) {
  return {
    google_sub: 'account-a',
    ...overrides,
  }
}

async function makeEnv(kv: FakeKV) {
  const seeded = await createPasskeyTestEnv(JSON.parse(await kv.get('session:sid123') ?? '{"google_sub":"account-a"}'))
  const base = seeded.env
  return { ...base, testHeaders: seeded.headers, S3_WORKFLOW_SERVICE: {
    mutateDiaryEntry: async (input: { sessionId: string; date: string; body: string; vaultKey?: string; accessToken: string; expiresAt: number }) => {
      const session = await getSession(input.sessionId, base, input.vaultKey)
      if (!session) return new Response('{}', { status: 401 })
      session.access_token = input.accessToken
      session.expires_at = input.expiresAt
      return saveDiaryEntry({
        request: new Request('https://example.com/', { method: 'POST', body: input.body }),
        params: { date: input.date }, env: base as never,
        data: { session, sessionId: input.sessionId, accessToken: input.accessToken }, waitUntil: vi.fn(),
      })
    },
  } }
}

// Chains api/_middleware.ts to the GET entry/[date] handler via a single shared
// context, the same object both layers read/write in production.
function makeChainedContext(request: Request, env: Awaited<ReturnType<typeof makeEnv>>, params: Record<string, string>) {
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
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
    aud: 'client-id', sub: 'account-a', expires_in: 3600,
    scope: 'openid email https://www.googleapis.com/auth/drive.file',
  }), { status: 200 })))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('api/_middleware.ts + drive/entry/[date].ts — real wiring', () => {
  it.each([
    { force: true },
    {},
    { baseVersion: '7' },
  ])('blocks updates outside the diary folder through real file authorization with options %j', async (options) => {
    const kv = createFakeKV({ 'session:sid123': JSON.stringify(makeSession({ folder_id: 'diary-folder' })) })
    const env = await makeEnv(kv)
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      if (String(input).includes('/tokeninfo')) return Promise.resolve(new Response(JSON.stringify({
        aud: 'client-id', sub: 'account-a', expires_in: 3600,
        scope: 'openid email https://www.googleapis.com/auth/drive.file',
      }), { status: 200 }))
      return Promise.resolve(new Response(JSON.stringify({
        id: 'externalFile12345678', name: 'diary-2026-05-01.txt', mimeType: 'text/plain',
        parents: ['another-folder'], version: '7', trashed: false,
      })))
    })
    vi.stubGlobal('fetch', fetchMock)
    const request = new Request('https://example.com/api/drive/entry/2026-05-01', {
      method: 'POST',
      headers: { ...env.testHeaders, Cookie: 'linger_session=sid123', 'X-Linger-Account': 'sub:account-a', Authorization: 'Bearer at-123', Origin: 'https://example.com' },
      body: JSON.stringify({ content: 'overwrite', fileId: 'externalFile12345678', ...options }),
    })
    const context = makeChainedContext(request, env, { date: '2026-05-01' })
    context.next = vi.fn(() => onPostEntry(context as never))

    const response = await apiMiddleware(context as never)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ conflict: null })
    // Only the metadata GET may reach Google; no content read or PATCH.
    const driveCalls = fetchMock.mock.calls.filter(call => String(call[0]).includes('/drive/v3/files/'))
    expect(driveCalls).toHaveLength(1)
    expect(driveCalls[0][0]).toContain('/drive/v3/files/externalFile12345678?fields=')
    expect(driveCalls[0][1].method).toBeUndefined()
    expect(context.waitUntil).not.toHaveBeenCalled()
  })

  it('threads sessionId/accessToken from middleware into the handler and returns the entry', async () => {
    const kv = createFakeKV({ 'session:sid123': JSON.stringify(makeSession()) })
    const env = await makeEnv(kv)
    const request = new Request('http://localhost/api/drive/entry/2026-05-01', {
      headers: { ...env.testHeaders, Cookie: 'linger_session=sid123', 'X-Linger-Account': 'sub:account-a', Authorization: 'Bearer at-123' },
    })
    const context = makeChainedContext(request, env, { date: '2026-05-01' })

    const response = await apiMiddleware(context as never)

    expect(response.status).toBe(200)
    expect(context.next).toHaveBeenCalledOnce()
    // The handler actually ran with the accessToken the middleware validated from the request,
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
    expect(await getPasskeySessionUserId('sid123', env as never)).toBeTruthy()
  })

  it('blocks the handler entirely when there is no session cookie', async () => {
    const kv = createFakeKV()
    const env = await makeEnv(kv)
    const request = new Request('http://localhost/api/drive/entry/2026-05-01')
    const context = makeChainedContext(request, env, { date: '2026-05-01' })

    const response = await apiMiddleware(context as never)

    expect(response.status).toBe(401)
    expect(context.next).not.toHaveBeenCalled()
    expect(vi.mocked(drive.findEntryMeta)).not.toHaveBeenCalled()
  })

  it('blocks the handler when request credentials are expired and preserves the metadata session', async () => {
    const kv = createFakeKV({ 'session:sid123': JSON.stringify(makeSession()) })
    const env = await makeEnv(kv)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      aud: 'client-id', sub: 'account-a', expires_in: 0,
      scope: 'openid email https://www.googleapis.com/auth/drive.file',
    }), { status: 200 })))
    const request = new Request('http://localhost/api/drive/entry/2026-05-01', {
      headers: { ...env.testHeaders, Cookie: 'linger_session=sid123', 'X-Linger-Account': 'sub:account-a', Authorization: 'Bearer expired' },
    })
    const context = makeChainedContext(request, env, { date: '2026-05-01' })

    const response = await apiMiddleware(context as never)

    expect(response.status).toBe(401)
    expect(context.next).not.toHaveBeenCalled()
    expect(vi.mocked(drive.findEntryMeta)).not.toHaveBeenCalled()
    expect(await getPasskeySessionUserId('sid123', env as never)).toBeTruthy()
  })
})
