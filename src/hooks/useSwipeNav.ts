import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'

// Movement below this is treated as a tap; beyond it the gesture locks to the
// dominant axis, and a vertical lock hands the touch over to native scrolling.
const DIRECTION_LOCK_PX = 10
const SWIPE_DISTANCE_PX = 70
// A faster flick may travel less distance and still count as a swipe.
const FLICK_DISTANCE_PX = 40
const FLICK_VELOCITY_PX_MS = 0.5
// Touches starting at the screen edge are likely the browser's own
// back/forward navigation gesture — leave those alone.
const EDGE_GUARD_PX = 24

interface SwipeNavHandlers {
  onSwipeLeft: () => void
  onSwipeRight: () => void
}

function hasTextSelection(target: EventTarget | null): boolean {
  return (
    (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) &&
    target.selectionStart !== target.selectionEnd
  )
}

// Detects deliberate horizontal touch swipes on the given element. Listeners
// are passive and never call preventDefault, so native vertical scrolling and
// long-press text selection keep working; pair with `touch-action: pan-y` on
// the element so the browser knows horizontal panning is handled here.
export function useSwipeNav(ref: RefObject<HTMLElement | null>, handlers: SwipeNavHandlers) {
  const handlersRef = useRef(handlers)
  useEffect(() => { handlersRef.current = handlers }, [handlers])

  useEffect(() => {
    const el = ref.current
    if (!el) return

    let active = false
    let axis: 'x' | 'y' | null = null
    let startX = 0
    let startY = 0
    let startTime = 0

    const onTouchStart = (e: TouchEvent) => {
      active = false
      if (e.touches.length !== 1) return
      const t = e.touches[0]
      if (t.clientX < EDGE_GUARD_PX || t.clientX > window.innerWidth - EDGE_GUARD_PX) return
      // A touch starting while text is selected is most likely a selection
      // handle being dragged — large horizontal movement, but not a swipe.
      if (hasTextSelection(e.target)) return
      active = true
      axis = null
      startX = t.clientX
      startY = t.clientY
      startTime = e.timeStamp
    }

    const onTouchMove = (e: TouchEvent) => {
      if (!active) return
      if (e.touches.length !== 1) { active = false; return }
      if (axis !== null) return
      const dx = Math.abs(e.touches[0].clientX - startX)
      const dy = Math.abs(e.touches[0].clientY - startY)
      if (Math.max(dx, dy) < DIRECTION_LOCK_PX) return
      axis = dx > dy ? 'x' : 'y'
    }

    const onTouchEnd = (e: TouchEvent) => {
      if (!active) return
      active = false
      if (axis !== 'x') return
      // Long-press during the gesture may have selected text (and dragging
      // extended the selection) — that movement is not a swipe either.
      if (hasTextSelection(e.target)) return
      const t = e.changedTouches[0]
      if (!t) return
      const dx = t.clientX - startX
      const dy = t.clientY - startY
      const absDx = Math.abs(dx)
      if (Math.abs(dy) > absDx / 2) return
      const dt = Math.max(1, e.timeStamp - startTime)
      const isSwipe = absDx >= SWIPE_DISTANCE_PX
        || (absDx >= FLICK_DISTANCE_PX && absDx / dt >= FLICK_VELOCITY_PX_MS)
      if (!isSwipe) return
      if (dx < 0) handlersRef.current.onSwipeLeft()
      else handlersRef.current.onSwipeRight()
    }

    const onTouchCancel = () => { active = false }

    const opts: AddEventListenerOptions = { passive: true }
    el.addEventListener('touchstart', onTouchStart, opts)
    el.addEventListener('touchmove', onTouchMove, opts)
    el.addEventListener('touchend', onTouchEnd, opts)
    el.addEventListener('touchcancel', onTouchCancel, opts)
    return () => {
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchCancel)
    }
  }, [ref])
}
