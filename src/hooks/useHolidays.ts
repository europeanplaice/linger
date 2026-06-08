import { useEffect, useState } from 'react'
import { fetchHolidays } from '../api/holidays'
import type { HolidayCountry, HolidayMap } from '../utils/holidays'

const EMPTY: HolidayMap = {}

// Holidays for a given (country, year) are immutable, so cache them at module
// level. Month/year navigation and component remounts then reuse the data
// instead of refetching. A failed load is NOT cached, so it retries later.
const cache = new Map<string, HolidayMap>()
const inflight = new Map<string, Promise<HolidayMap>>()

function load(country: HolidayCountry, year: number): Promise<HolidayMap> {
  const key = `${country}:${year}`
  const cached = cache.get(key)
  if (cached) return Promise.resolve(cached)

  let pending = inflight.get(key)
  if (!pending) {
    pending = fetchHolidays(country, year)
      .then(map => { cache.set(key, map); inflight.delete(key); return map })
      .catch(() => { inflight.delete(key); return EMPTY }) // graceful: offline/error → no holidays
    inflight.set(key, pending)
  }
  return pending
}

/**
 * Holiday map for the given country and year. Returns an empty map when the
 * feature is off or while loading, and never throws — holidays are decorative
 * and must not affect diary functionality.
 */
export function useHolidays(country: HolidayCountry, year: number): HolidayMap {
  const [map, setMap] = useState<HolidayMap>(() =>
    country === 'off' ? EMPTY : (cache.get(`${country}:${year}`) ?? EMPTY))

  useEffect(() => {
    if (country === 'off') { setMap(EMPTY); return }
    let active = true
    load(country, year).then(m => { if (active) setMap(m) })
    return () => { active = false }
  }, [country, year])

  return map
}
