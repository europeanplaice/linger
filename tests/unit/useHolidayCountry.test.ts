import { renderHook, act } from '@testing-library/react'
import { beforeEach, expect, test } from 'vitest'
import { useHolidayCountry } from '../../src/hooks/useHolidayCountry'
import type { Language } from '../../src/i18n'

const STORAGE_KEY = 'linger_holiday_country'

beforeEach(() => {
  localStorage.clear()
})

test('defaults to JP when language is ja and nothing is stored', () => {
  const { result } = renderHook(() => useHolidayCountry('ja'))
  expect(result.current.country).toBe('JP')
})

test('defaults to US when language is en and nothing is stored', () => {
  const { result } = renderHook(() => useHolidayCountry('en'))
  expect(result.current.country).toBe('US')
})

test('follows the language when the user has not chosen explicitly', () => {
  const { result, rerender } = renderHook(
    ({ lang }: { lang: Language }) => useHolidayCountry(lang),
    { initialProps: { lang: 'ja' as Language } },
  )
  expect(result.current.country).toBe('JP')

  rerender({ lang: 'en' })
  expect(result.current.country).toBe('US')
})

test('an explicit choice is persisted and overrides the language default', () => {
  const { result } = renderHook(() => useHolidayCountry('ja'))

  act(() => result.current.setCountry('GB'))
  expect(result.current.country).toBe('GB')
  expect(localStorage.getItem(STORAGE_KEY)).toBe('GB')
})

test('an explicit choice wins over later language changes', () => {
  const { result, rerender } = renderHook(
    ({ lang }: { lang: Language }) => useHolidayCountry(lang),
    { initialProps: { lang: 'en' as Language } },
  )

  act(() => result.current.setCountry('FR'))
  rerender({ lang: 'ja' })
  expect(result.current.country).toBe('FR')
})

test('an explicit "off" is respected and does not fall back to the language default', () => {
  localStorage.setItem(STORAGE_KEY, 'off')
  const { result } = renderHook(() => useHolidayCountry('ja'))
  expect(result.current.country).toBe('off')
})

test('reads a stored country code on init', () => {
  localStorage.setItem(STORAGE_KEY, 'DE')
  const { result } = renderHook(() => useHolidayCountry('ja'))
  expect(result.current.country).toBe('DE')
})

test('ignores an invalid stored value and uses the language default', () => {
  localStorage.setItem(STORAGE_KEY, 'XX')
  const { result } = renderHook(() => useHolidayCountry('en'))
  expect(result.current.country).toBe('US')
})
