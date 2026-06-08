import { apiFetch } from './driveEntries'
import type { HolidayMap } from '../utils/holidays'

/**
 * Fetch the holiday map for a country/year via the server proxy.
 * Returns an empty map on a 404 (no coverage); other failures throw and are
 * handled by the caller (useHolidays) as "no holidays".
 */
export async function fetchHolidays(country: string, year: number): Promise<HolidayMap> {
  const { data } = await apiFetch<{ holidays: HolidayMap }>(
    `/api/holidays/${encodeURIComponent(country)}/${encodeURIComponent(year)}`,
  )
  return data?.holidays ?? {}
}
