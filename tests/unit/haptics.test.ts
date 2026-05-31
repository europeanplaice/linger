import { describe, it, expect, vi, afterEach } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

async function loadHaptics() {
  const mod = await import('../../src/utils/haptics')
  return mod.haptics
}

describe('haptics', () => {
  it('calls navigator.vibrate with the correct pattern for each method', async () => {
    const vibrate = vi.fn()
    vi.stubGlobal('navigator', { vibrate })

    const haptics = await loadHaptics()

    haptics.tap()
    expect(vibrate).toHaveBeenCalledWith(10)

    haptics.success()
    expect(vibrate).toHaveBeenCalledWith(10)

    haptics.warning()
    expect(vibrate).toHaveBeenCalledWith([0, 30, 60, 30])

    haptics.error()
    expect(vibrate).toHaveBeenCalledWith([0, 40, 50, 40])

    haptics.delete()
    expect(vibrate).toHaveBeenCalledWith([0, 20, 40, 20])
  })

  it('does not throw when navigator.vibrate is unsupported', async () => {
    vi.stubGlobal('navigator', {})

    const haptics = await loadHaptics()

    expect(() => haptics.tap()).not.toThrow()
    expect(() => haptics.success()).not.toThrow()
    expect(() => haptics.warning()).not.toThrow()
    expect(() => haptics.error()).not.toThrow()
    expect(() => haptics.delete()).not.toThrow()
  })
})
