import type { Env, Data } from '../../../_shared/session'
import { jsonResponse } from '../../../_shared/session'

// Proxy + cache for public holidays. The browser calls this authenticated
// endpoint; the third-party API (Nager.Date) is only ever reached server-side.
// Results are immutable per (country, year), so we cache them in KV for a long
// time and serve cache hits without touching the upstream.

// Keep in sync with HOLIDAY_COUNTRY_CODES in src/utils/holidays.ts.
const ALLOWED_COUNTRIES = new Set(['JP', 'US', 'GB', 'DE', 'FR'])
const MIN_YEAR = 1975
const CACHE_TTL = 60 * 60 * 24 * 90 // 90 days

interface NagerHoliday {
  date: string
  localName: string
  name: string
  global: boolean
}

interface HolidayInfo {
  localName: string
  name: string
}

async function fetchWithRetry(url: string): Promise<Response> {
  const delays = [250, 500, 1000]
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Accept: 'application/json' } })
    if (res.ok || res.status === 404) return res
    if ((res.status === 429 || res.status >= 500) && attempt < delays.length) {
      let delay = delays[attempt]
      const ra = res.headers.get('Retry-After')
      if (ra) { const s = parseFloat(ra); if (!isNaN(s)) delay = s * 1000 }
      await new Promise(r => setTimeout(r, delay * (1 + 0.2 * (Math.random() * 2 - 1))))
      continue
    }
    return res
  }
}

export const onRequestGet: PagesFunction<Env, string, Data> = async (context) => {
  const { session } = context.data
  if (!session) return jsonResponse({ error: 'Unauthorized' }, 401)

  // Validate inputs before touching the upstream (prevents proxy abuse / SSRF).
  const country = String(context.params.country ?? '').toUpperCase()
  const yearStr = String(context.params.year ?? '')
  const year = Number(yearStr)
  const maxYear = new Date().getFullYear() + 5

  if (!ALLOWED_COUNTRIES.has(country)) {
    return jsonResponse({ error: 'Unsupported country' }, 400)
  }
  if (!/^\d{4}$/.test(yearStr) || year < MIN_YEAR || year > maxYear) {
    return jsonResponse({ error: 'Invalid year' }, 400)
  }

  const cacheKey = `holiday:${country}:${year}`
  try {
    const cached = await context.env.SESSIONS.get(cacheKey)
    if (cached) return jsonResponse({ holidays: JSON.parse(cached) as Record<string, HolidayInfo> })
  } catch (e) {
    console.error('holidays.ts: KV read failed', e)
  }

  const holidays: Record<string, HolidayInfo> = {}
  try {
    const res = await fetchWithRetry(`https://date.nager.at/api/v3/PublicHolidays/${year}/${country}`)
    // 404 = country/year not covered; treat as "no holidays" and cache it.
    if (res.status !== 404) {
      if (!res.ok) return jsonResponse({ error: 'Upstream error' }, 502)
      const data = await res.json() as NagerHoliday[]
      for (const h of data) {
        // Skip regional-only holidays so the calendar shows nationwide days only.
        if (h.global === false) continue
        if (!/^\d{4}-\d{2}-\d{2}$/.test(h.date)) continue
        holidays[h.date] = { localName: h.localName, name: h.name }
      }
    }
  } catch (e) {
    console.error('holidays.ts: upstream fetch failed', e)
    return jsonResponse({ error: 'Upstream error' }, 502)
  }

  try {
    await context.env.SESSIONS.put(cacheKey, JSON.stringify(holidays), { expirationTtl: CACHE_TTL })
  } catch (e) {
    console.error('holidays.ts: KV write failed', e)
  }

  return jsonResponse({ holidays })
}
