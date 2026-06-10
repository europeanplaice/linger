import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useSwipeNav } from '../../src/hooks/useSwipeNav'

interface FakeTouchInit {
  type: string
  x: number
  y: number
  timeStamp?: number
  touchCount?: number
  target?: EventTarget
}

// jsdom cannot construct real TouchEvents, so fabricate plain events carrying
// the touches/changedTouches shape the hook reads.
function dispatchTouch(el: EventTarget, { type, x, y, timeStamp, touchCount = 1, target }: FakeTouchInit) {
  const e = new Event(type, { bubbles: true }) as Event & {
    touches: { clientX: number; clientY: number }[]
    changedTouches: { clientX: number; clientY: number }[]
  }
  const point = { clientX: x, clientY: y }
  e.touches = type === 'touchend' || type === 'touchcancel'
    ? []
    : Array.from({ length: touchCount }, () => point)
  e.changedTouches = [point]
  if (timeStamp !== undefined) {
    Object.defineProperty(e, 'timeStamp', { value: timeStamp })
  }
  ;(target ?? el).dispatchEvent(e)
}

function swipe(el: EventTarget, fromX: number, toX: number, y = 200, opts: { durationMs?: number; toY?: number; target?: EventTarget } = {}) {
  const { durationMs = 200, toY = y, target } = opts
  dispatchTouch(el, { type: 'touchstart', x: fromX, y, timeStamp: 1000, target })
  dispatchTouch(el, { type: 'touchmove', x: (fromX + toX) / 2, y: (y + toY) / 2, timeStamp: 1000 + durationMs / 2, target })
  dispatchTouch(el, { type: 'touchend', x: toX, y: toY, timeStamp: 1000 + durationMs, target })
}

describe('useSwipeNav', () => {
  let el: HTMLDivElement
  let onSwipeLeft: Mock<() => void>
  let onSwipeRight: Mock<() => void>

  beforeEach(() => {
    el = document.createElement('div')
    document.body.replaceChildren(el)
    onSwipeLeft = vi.fn<() => void>()
    onSwipeRight = vi.fn<() => void>()
  })

  function render() {
    return renderHook(() => useSwipeNav({ current: el }, { onSwipeLeft, onSwipeRight }))
  }

  it('fires onSwipeLeft for a long leftward swipe', () => {
    render()
    swipe(el, 300, 200)
    expect(onSwipeLeft).toHaveBeenCalledTimes(1)
    expect(onSwipeRight).not.toHaveBeenCalled()
  })

  it('fires onSwipeRight for a long rightward swipe', () => {
    render()
    swipe(el, 200, 300)
    expect(onSwipeRight).toHaveBeenCalledTimes(1)
    expect(onSwipeLeft).not.toHaveBeenCalled()
  })

  it('fires for a short but fast flick', () => {
    render()
    swipe(el, 300, 250, 200, { durationMs: 60 })
    expect(onSwipeLeft).toHaveBeenCalledTimes(1)
  })

  it('ignores a short slow drag', () => {
    render()
    swipe(el, 300, 250, 200, { durationMs: 600 })
    expect(onSwipeLeft).not.toHaveBeenCalled()
  })

  it('ignores a gesture that locks to the vertical axis', () => {
    render()
    dispatchTouch(el, { type: 'touchstart', x: 300, y: 100, timeStamp: 1000 })
    dispatchTouch(el, { type: 'touchmove', x: 305, y: 160, timeStamp: 1100 })
    dispatchTouch(el, { type: 'touchend', x: 200, y: 300, timeStamp: 1200 })
    expect(onSwipeLeft).not.toHaveBeenCalled()
    expect(onSwipeRight).not.toHaveBeenCalled()
  })

  it('ignores a mostly-diagonal release even after a horizontal lock', () => {
    render()
    dispatchTouch(el, { type: 'touchstart', x: 300, y: 100, timeStamp: 1000 })
    dispatchTouch(el, { type: 'touchmove', x: 280, y: 105, timeStamp: 1050 })
    dispatchTouch(el, { type: 'touchend', x: 200, y: 200, timeStamp: 1200 })
    expect(onSwipeLeft).not.toHaveBeenCalled()
  })

  it('ignores touches starting at the screen edge', () => {
    render()
    swipe(el, 10, 150)
    swipe(el, window.innerWidth - 10, window.innerWidth - 150)
    expect(onSwipeLeft).not.toHaveBeenCalled()
    expect(onSwipeRight).not.toHaveBeenCalled()
  })

  it('ignores multi-touch gestures', () => {
    render()
    dispatchTouch(el, { type: 'touchstart', x: 300, y: 200, timeStamp: 1000, touchCount: 2 })
    dispatchTouch(el, { type: 'touchmove', x: 250, y: 200, timeStamp: 1100, touchCount: 2 })
    dispatchTouch(el, { type: 'touchend', x: 200, y: 200, timeStamp: 1200 })
    expect(onSwipeLeft).not.toHaveBeenCalled()
  })

  it('cancels when a second finger joins mid-gesture', () => {
    render()
    dispatchTouch(el, { type: 'touchstart', x: 300, y: 200, timeStamp: 1000 })
    dispatchTouch(el, { type: 'touchmove', x: 250, y: 200, timeStamp: 1050, touchCount: 2 })
    dispatchTouch(el, { type: 'touchend', x: 200, y: 200, timeStamp: 1200 })
    expect(onSwipeLeft).not.toHaveBeenCalled()
  })

  it('ignores swipes while the target textarea has a selection', () => {
    const textarea = document.createElement('textarea')
    textarea.value = 'hello world'
    el.appendChild(textarea)
    textarea.setSelectionRange(0, 5)
    render()
    swipe(el, 300, 200, 200, { target: textarea })
    expect(onSwipeLeft).not.toHaveBeenCalled()
  })

  it('ignores a swipe whose long-press created a selection mid-gesture', () => {
    const textarea = document.createElement('textarea')
    textarea.value = 'hello world'
    el.appendChild(textarea)
    textarea.setSelectionRange(2, 2)
    render()
    dispatchTouch(el, { type: 'touchstart', x: 300, y: 200, timeStamp: 1000, target: textarea })
    dispatchTouch(el, { type: 'touchmove', x: 250, y: 200, timeStamp: 1100, target: textarea })
    textarea.setSelectionRange(0, 5)
    dispatchTouch(el, { type: 'touchend', x: 200, y: 200, timeStamp: 1200, target: textarea })
    expect(onSwipeLeft).not.toHaveBeenCalled()
  })

  it('does nothing after touchcancel', () => {
    render()
    dispatchTouch(el, { type: 'touchstart', x: 300, y: 200, timeStamp: 1000 })
    dispatchTouch(el, { type: 'touchmove', x: 250, y: 200, timeStamp: 1050 })
    dispatchTouch(el, { type: 'touchcancel', x: 250, y: 200, timeStamp: 1060 })
    dispatchTouch(el, { type: 'touchend', x: 200, y: 200, timeStamp: 1200 })
    expect(onSwipeLeft).not.toHaveBeenCalled()
  })

  it('treats a tap (no movement) as nothing', () => {
    render()
    dispatchTouch(el, { type: 'touchstart', x: 300, y: 200, timeStamp: 1000 })
    dispatchTouch(el, { type: 'touchend', x: 300, y: 200, timeStamp: 1100 })
    expect(onSwipeLeft).not.toHaveBeenCalled()
    expect(onSwipeRight).not.toHaveBeenCalled()
  })

  it('removes listeners on unmount', () => {
    const { unmount } = render()
    unmount()
    swipe(el, 300, 200)
    expect(onSwipeLeft).not.toHaveBeenCalled()
  })
})
