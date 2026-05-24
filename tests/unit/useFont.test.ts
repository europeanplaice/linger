import { renderHook, act } from '@testing-library/react'
import { useFont } from '../../src/hooks/useFont'

beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-font')
})

test('initializes with stored font from localStorage', () => {
  localStorage.setItem('linger_font', 'sans')
  const { result } = renderHook(() => useFont())
  expect(result.current.mode).toBe('sans')
  expect(document.documentElement.getAttribute('data-font')).toBe('sans')
})

test('defaults to sans when no stored font', () => {
  localStorage.removeItem('linger_font')
  const { result } = renderHook(() => useFont())
  expect(result.current.mode).toBe('sans')
  expect(document.documentElement.getAttribute('data-font')).toBe('sans')
})

test('toggleFont switches sans → serif → sans', () => {
  localStorage.removeItem('linger_font')
  const { result } = renderHook(() => useFont())
  expect(result.current.mode).toBe('sans')

  act(() => result.current.toggleFont())
  expect(result.current.mode).toBe('serif')
  expect(localStorage.getItem('linger_font')).toBe('serif')

  act(() => result.current.toggleFont())
  expect(result.current.mode).toBe('sans')
  expect(localStorage.getItem('linger_font')).toBe('sans')
})
