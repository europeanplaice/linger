// Shared holiday types and the supported-country allowlist.
//
// Holiday data itself is fetched at runtime from the server proxy
// (`/api/holidays/{country}/{year}`), which talks to the Nager.Date public API.
// This module only defines the country options and value guards used by the UI.

export type HolidayCountryCode = 'JP' | 'US' | 'GB' | 'DE' | 'FR'

/** `'off'` disables the feature; otherwise a supported ISO-3166 country code. */
export type HolidayCountry = 'off' | HolidayCountryCode

// Countries offered in the settings holiday selector. Keep this in sync with the
// allowlist in functions/api/holidays/[country]/[year].ts.
export const HOLIDAY_COUNTRY_CODES: readonly HolidayCountryCode[] = ['JP', 'US', 'GB', 'DE', 'FR']

export function isHolidayCountryCode(value: string): value is HolidayCountryCode {
  return (HOLIDAY_COUNTRY_CODES as readonly string[]).includes(value)
}

export function isHolidayCountry(value: string): value is HolidayCountry {
  return value === 'off' || isHolidayCountryCode(value)
}

export interface HolidayInfo {
  localName: string // name in the country's own language (e.g. 元日)
  name: string // English name (e.g. New Year's Day)
}

/** Map of YYYY-MM-DD → holiday for a single year. */
export type HolidayMap = Record<string, HolidayInfo>
