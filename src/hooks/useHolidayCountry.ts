import { useState, useCallback } from 'react'
import type { HolidayCountry } from '../utils/holidays'
import { isHolidayCountry } from '../utils/holidays'

const STORAGE_KEY = 'linger_holiday_country'

function readStored(): HolidayCountry {
  if (typeof window === 'undefined') return 'off'
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored && isHolidayCountry(stored)) return stored
  return 'off'
}

export function useHolidayCountry() {
  const [country, setCountryState] = useState<HolidayCountry>(readStored)

  const setCountry = useCallback((next: HolidayCountry) => {
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Storage may be unavailable (private mode); selection still applies in-memory.
    }
    setCountryState(next)
  }, [])

  return { country, setCountry }
}
