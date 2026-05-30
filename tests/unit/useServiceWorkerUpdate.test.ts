import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useServiceWorkerUpdate } from '../../src/hooks/useServiceWorkerUpdate'

class MockServiceWorker extends EventTarget {
  state = 'installing'
  postMessage = vi.fn()
}

class MockRegistration extends EventTarget {
  waiting: MockServiceWorker | null = null
  installing: MockServiceWorker | null = null
  update = vi.fn()
}

function makeMockContainer(reg: MockRegistration, hasController = true) {
  const et = new EventTarget()
  return Object.assign(et, {
    controller: hasController ? {} : null,
    ready: Promise.resolve(reg),
  })
}

let originalDEV: boolean

beforeEach(() => {
  originalDEV = import.meta.env.DEV
  ;(import.meta.env as Record<string, unknown>).DEV = false
  vi.stubGlobal('location', { reload: vi.fn() })
  vi.useFakeTimers()
})

afterEach(() => {
  ;(import.meta.env as Record<string, unknown>).DEV = originalDEV
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('useServiceWorkerUpdate', () => {
  describe('apply on startup', () => {
    it('posts SKIP_WAITING when a waiting SW is present and not dirty', async () => {
      const reg = new MockRegistration()
      const waiting = new MockServiceWorker()
      reg.waiting = waiting
      const container = makeMockContainer(reg)
      Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: container })
      renderHook(() => useServiceWorkerUpdate(false))
      await act(async () => {})

      expect(waiting.postMessage).toHaveBeenCalledWith('SKIP_WAITING')

      act(() => { container.dispatchEvent(new Event('controllerchange')) })
      expect(window.location.reload).toHaveBeenCalledTimes(1)
    })

    it('does not apply on startup when dirty', async () => {
      const reg = new MockRegistration()
      reg.waiting = new MockServiceWorker()
      Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: makeMockContainer(reg),
      })
      renderHook(() => useServiceWorkerUpdate(true))
      await act(async () => {})

      expect(reg.waiting.postMessage).not.toHaveBeenCalled()
    })
  })

  describe('dirty state transition', () => {
    it('does NOT auto-apply when dirty goes false — apply only happens on hidden', async () => {
      const reg = new MockRegistration()
      const waiting = new MockServiceWorker()
      reg.waiting = waiting
      Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: makeMockContainer(reg),
      })
      const { rerender } = renderHook(
        ({ dirty }: { dirty: boolean }) => useServiceWorkerUpdate(dirty),
        { initialProps: { dirty: true } },
      )
      await act(async () => {})
      expect(waiting.postMessage).not.toHaveBeenCalled()

      await act(async () => { rerender({ dirty: false }) })
      expect(waiting.postMessage).not.toHaveBeenCalled()
    })
  })

  describe('apply on hidden', () => {
    it('applies when tab becomes hidden after SW arrived while dirty', async () => {
      const reg = new MockRegistration()
      const installing = new MockServiceWorker()
      const container = makeMockContainer(reg, true)
      Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: container })

      const { rerender } = renderHook(
        ({ dirty }: { dirty: boolean }) => useServiceWorkerUpdate(dirty),
        { initialProps: { dirty: true } },
      )
      await act(async () => {})

      // New SW arrives while user is editing — maybeApply blocked by dirty
      act(() => {
        reg.installing = installing
        reg.dispatchEvent(new Event('updatefound'))
      })
      act(() => {
        installing.state = 'installed'
        reg.waiting = installing
        installing.dispatchEvent(new Event('statechange'))
      })
      expect(installing.postMessage).not.toHaveBeenCalled()

      // User saves (dirty → false) but stays on the tab — still no apply
      await act(async () => { rerender({ dirty: false }) })
      expect(installing.postMessage).not.toHaveBeenCalled()

      // User leaves the tab — apply happens now
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
      act(() => { document.dispatchEvent(new Event('visibilitychange')) })

      expect(installing.postMessage).toHaveBeenCalledWith('SKIP_WAITING')
    })

    it('does not apply when tab becomes hidden but dirty', async () => {
      const reg = new MockRegistration()
      reg.waiting = new MockServiceWorker()
      Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: makeMockContainer(reg),
      })
      renderHook(() => useServiceWorkerUpdate(true))
      await act(async () => {})

      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
      act(() => { document.dispatchEvent(new Event('visibilitychange')) })

      expect(reg.waiting!.postMessage).not.toHaveBeenCalled()
    })
  })

  describe('visibilitychange visible', () => {
    it('calls reg.update() but does not apply when tab becomes visible', async () => {
      const reg = new MockRegistration()
      const waiting = new MockServiceWorker()
      reg.waiting = waiting
      Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: makeMockContainer(reg),
      })
      renderHook(() => useServiceWorkerUpdate(false))
      await act(async () => {})

      waiting.postMessage.mockClear()

      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
      act(() => { document.dispatchEvent(new Event('visibilitychange')) })

      expect(reg.update).toHaveBeenCalledTimes(1)
      expect(waiting.postMessage).not.toHaveBeenCalled()
    })

    it('removes the visibilitychange listener on unmount', async () => {
      const reg = new MockRegistration()
      Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: makeMockContainer(reg),
      })
      const { unmount } = renderHook(() => useServiceWorkerUpdate(false))
      await act(async () => {})
      unmount()

      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
      act(() => { document.dispatchEvent(new Event('visibilitychange')) })

      expect(reg.update).not.toHaveBeenCalled()
    })
  })

  describe('updatefound / statechange', () => {
    it('applies when a new SW reaches installed state and not dirty', async () => {
      const reg = new MockRegistration()
      const installing = new MockServiceWorker()
      const container = makeMockContainer(reg, true)
      Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: container })
      renderHook(() => useServiceWorkerUpdate(false))
      await act(async () => {})

      act(() => {
        reg.installing = installing
        reg.dispatchEvent(new Event('updatefound'))
      })
      act(() => {
        installing.state = 'installed'
        reg.waiting = installing
        installing.dispatchEvent(new Event('statechange'))
      })

      expect(installing.postMessage).toHaveBeenCalledWith('SKIP_WAITING')
    })

    it('does not apply on first install when no existing controller', async () => {
      const reg = new MockRegistration()
      const installing = new MockServiceWorker()
      const container = makeMockContainer(reg, false)
      Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: container })
      renderHook(() => useServiceWorkerUpdate(false))
      await act(async () => {})

      act(() => {
        reg.installing = installing
        reg.dispatchEvent(new Event('updatefound'))
      })
      act(() => {
        installing.state = 'installed'
        reg.waiting = installing
        installing.dispatchEvent(new Event('statechange'))
      })

      expect(installing.postMessage).not.toHaveBeenCalled()
      expect(window.location.reload).not.toHaveBeenCalled()
    })
  })

  describe('reload safety', () => {
    it('reloads only once even if controllerchange fires multiple times', async () => {
      const reg = new MockRegistration()
      reg.waiting = new MockServiceWorker()
      const container = makeMockContainer(reg)
      Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: container })
      renderHook(() => useServiceWorkerUpdate(false))
      await act(async () => {})

      act(() => {
        container.dispatchEvent(new Event('controllerchange'))
        container.dispatchEvent(new Event('controllerchange'))
      })
      expect(window.location.reload).toHaveBeenCalledTimes(1)
    })

    it('clears the fallback timeout when controllerchange fires', async () => {
      const reg = new MockRegistration()
      reg.waiting = new MockServiceWorker()
      const container = makeMockContainer(reg)
      Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: container })
      renderHook(() => useServiceWorkerUpdate(false))
      await act(async () => {})

      act(() => { container.dispatchEvent(new Event('controllerchange')) })
      expect(window.location.reload).toHaveBeenCalledTimes(1)

      // Advance past the 4s fallback — should not reload again
      act(() => { vi.advanceTimersByTime(5000) })
      expect(window.location.reload).toHaveBeenCalledTimes(1)
    })

    it('reloads via fallback timeout if controllerchange never fires', async () => {
      const reg = new MockRegistration()
      reg.waiting = new MockServiceWorker()
      Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: makeMockContainer(reg),
      })
      renderHook(() => useServiceWorkerUpdate(false))
      await act(async () => {})

      act(() => { vi.advanceTimersByTime(4000) })
      expect(window.location.reload).toHaveBeenCalledTimes(1)
    })
  })
})
