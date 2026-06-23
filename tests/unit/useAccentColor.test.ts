import { renderHook, act } from '@testing-library/react'
import { useAccentColor } from '../../src/hooks/useAccentColor'

beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-accent')
})

test('defaults to indigo when nothing is stored', () => {
  const { result } = renderHook(() => useAccentColor())
  expect(result.current.accent).toBe('indigo')
})

test('applies data-accent="indigo" to documentElement on mount', () => {
  renderHook(() => useAccentColor())
  expect(document.documentElement.getAttribute('data-accent')).toBe('indigo')
})

test('reads sage from localStorage', () => {
  localStorage.setItem('linger_accent', 'sage')
  const { result } = renderHook(() => useAccentColor())
  expect(result.current.accent).toBe('sage')
  expect(document.documentElement.getAttribute('data-accent')).toBe('sage')
})

test('setAccent changes accent and persists to localStorage', () => {
  const { result } = renderHook(() => useAccentColor())
  expect(result.current.accent).toBe('indigo')

  act(() => result.current.setAccent('sage'))
  expect(result.current.accent).toBe('sage')
  expect(localStorage.getItem('linger_accent')).toBe('sage')
  expect(document.documentElement.getAttribute('data-accent')).toBe('sage')

  act(() => result.current.setAccent('indigo'))
  expect(result.current.accent).toBe('indigo')
  expect(localStorage.getItem('linger_accent')).toBe('indigo')
  expect(document.documentElement.getAttribute('data-accent')).toBe('indigo')
})

test('reads terracotta from localStorage', () => {
  localStorage.setItem('linger_accent', 'terracotta')
  const { result } = renderHook(() => useAccentColor())
  expect(result.current.accent).toBe('terracotta')
  expect(document.documentElement.getAttribute('data-accent')).toBe('terracotta')
})

test('setAccent switches to terracotta and persists to localStorage', () => {
  const { result } = renderHook(() => useAccentColor())

  act(() => result.current.setAccent('terracotta'))
  expect(result.current.accent).toBe('terracotta')
  expect(localStorage.getItem('linger_accent')).toBe('terracotta')
  expect(document.documentElement.getAttribute('data-accent')).toBe('terracotta')
})

test('unknown stored value falls back to indigo', () => {
  localStorage.setItem('linger_accent', 'magenta')
  const { result } = renderHook(() => useAccentColor())
  expect(result.current.accent).toBe('indigo')
})
