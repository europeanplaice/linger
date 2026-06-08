import { useState, useCallback } from 'react'
import type { HolidayCountry } from '../utils/holidays'
import { isHolidayCountry } from '../utils/holidays'
import type { Language } from '../i18n'

const STORAGE_KEY = 'linger_holiday_country'

// With no explicit choice, the holiday calendar follows the UI language: a
// Japanese UI shows Japanese holidays, otherwise US holidays. Other combinations
// (e.g. an English speaker living in Japan) are handled by changing the setting
// manually in Settings.
function defaultCountryForLanguage(language: Language): HolidayCountry {
  return language === 'ja' ? 'JP' : 'US'
}

function readStored(): HolidayCountry | null {
  if (typeof window === 'undefined') return null
  const stored = localStorage.getItem(STORAGE_KEY)
  return stored && isHolidayCountry(stored) ? stored : null
}

export function useHolidayCountry(language: Language) {
  // A stored value is an explicit user choice; its absence means "follow the
  // language default", so the effective country tracks language changes until
  // the user picks one themselves (including picking 'off' to hide holidays).
  const [stored, setStored] = useState<HolidayCountry | null>(readStored)
  const country = stored ?? defaultCountryForLanguage(language)

  const setCountry = useCallback((next: HolidayCountry) => {
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Storage may be unavailable (private mode); selection still applies in-memory.
    }
    setStored(next)
  }, [])

  return { country, setCountry }
}
