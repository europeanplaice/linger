import { afterEach, describe, expect, it, vi } from 'vitest'
import { onRequestGet as onHolidays } from '../../functions/api/holidays/[country]/[year]'

function makeContext(params: { country: string; year: string }, env: Record<string, unknown> = {}) {
  return {
    request: new Request('http://localhost/api/holidays'),
    params,
    data: { accessToken: 'tok', sessionId: 'sid', session: { access_token: 'tok' } },
    env: { SESSIONS: { get: vi.fn().mockResolvedValue(null), put: vi.fn().mockResolvedValue(undefined) }, ...env },
  }
}

const thisYear = String(new Date().getFullYear())

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('holidays handler — input validation', () => {
  it('rejects an unsupported country', async () => {
    const res = await onHolidays(makeContext({ country: 'ZZ', year: thisYear }) as any)
    expect(res.status).toBe(400)
  })

  it('rejects a non-numeric year', async () => {
    const res = await onHolidays(makeContext({ country: 'JP', year: 'abcd' }) as any)
    expect(res.status).toBe(400)
  })

  it('rejects a year far in the future', async () => {
    const res = await onHolidays(makeContext({ country: 'JP', year: String(new Date().getFullYear() + 6) }) as any)
    expect(res.status).toBe(400)
  })

  it('rejects a year before the minimum', async () => {
    const res = await onHolidays(makeContext({ country: 'JP', year: '1900' }) as any)
    expect(res.status).toBe(400)
  })

  it('returns 401 without a session', async () => {
    const ctx = makeContext({ country: 'JP', year: thisYear })
    ctx.data.session = undefined as any
    const res = await onHolidays(ctx as any)
    expect(res.status).toBe(401)
  })
})

describe('holidays handler — fetch + cache', () => {
  it('serves a cached value without hitting the upstream', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const cached = JSON.stringify({ '2026-01-01': { localName: '元日', name: "New Year's Day" } })
    const ctx = makeContext({ country: 'JP', year: '2026' }, {
      SESSIONS: { get: vi.fn().mockResolvedValue(cached), put: vi.fn() },
    })
    const res = await onHolidays(ctx as any)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ holidays: JSON.parse(cached) })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('fetches from upstream on a cache miss, drops regional-only days, and caches the result', async () => {
    const upstream = [
      { date: '2026-01-01', localName: '元日', name: "New Year's Day", global: true },
      { date: '2026-07-20', localName: '海の日', name: 'Marine Day', global: true },
      { date: '2026-05-05', localName: '県民の日', name: 'Regional Day', global: false },
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(upstream), { status: 200 })))
    const put = vi.fn().mockResolvedValue(undefined)
    const ctx = makeContext({ country: 'JP', year: '2026' }, {
      SESSIONS: { get: vi.fn().mockResolvedValue(null), put },
    })
    const res = await onHolidays(ctx as any)
    expect(res.status).toBe(200)
    const body = await res.json() as { holidays: Record<string, unknown> }
    expect(Object.keys(body.holidays)).toEqual(['2026-01-01', '2026-07-20'])
    expect(put).toHaveBeenCalledOnce()
    expect(put.mock.calls[0][0]).toBe('holiday:JP:2026')
  })

  it('treats an upstream 404 as no holidays', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })))
    const res = await onHolidays(makeContext({ country: 'JP', year: '2026' }) as any)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ holidays: {} })
  })

  it('returns 500 when the upstream errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 500 })))
    const res = await onHolidays(makeContext({ country: 'JP', year: '2026' }) as any)
    expect(res.status).toBe(500)
  })
})
