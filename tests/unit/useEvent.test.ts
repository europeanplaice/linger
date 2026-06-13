import { describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useEvent, useLatestRef } from '../../src/hooks/useEvent'

describe('useLatestRef', () => {
  it('keeps a stable ref object whose current always tracks the latest value', () => {
    const { result, rerender } = renderHook(({ value }) => useLatestRef(value), {
      initialProps: { value: 'a' },
    })

    const first = result.current
    expect(first.current).toBe('a')

    rerender({ value: 'b' })
    expect(result.current).toBe(first) // same ref object
    expect(result.current.current).toBe('b')
  })
})

describe('useEvent', () => {
  it('returns a stable function identity across rerenders', () => {
    const { result, rerender } = renderHook(({ fn }) => useEvent(fn), {
      initialProps: { fn: () => 1 },
    })

    const first = result.current
    rerender({ fn: () => 2 })
    expect(result.current).toBe(first)
  })

  it('always invokes the latest handler with the given args and return value', () => {
    let factor = 2
    const { result, rerender } = renderHook(() => useEvent((n: number) => n * factor))

    expect(result.current(3)).toBe(6)

    factor = 10
    rerender()
    expect(result.current(3)).toBe(30)
  })
})
