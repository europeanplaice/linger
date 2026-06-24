import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

// Tracks whether a scrollable element is pinned to its top/bottom edge so the
// caller can fade scroll affordances. Listeners are re-attached whenever the
// content changes; callers also call `attachScrollListeners` again once an
// enter animation finishes and the real element is in place.
export function useScrollEdges<T extends HTMLElement>(
  elementRef: RefObject<T | null>,
  { loading, text }: { loading: boolean; text: string },
) {
  const [scrollAtTop, setScrollAtTop] = useState(true)
  const [scrollAtBottom, setScrollAtBottom] = useState(true)
  const cleanupRef = useRef<(() => void) | undefined>(undefined)

  const attachScrollListeners = useCallback(() => {
    cleanupRef.current?.()
    cleanupRef.current = undefined
    const el = elementRef.current
    if (!el) return
    const update = () => {
      // Treat "near the top" (within ~half a line) as the top edge: focusing a
      // textarea can auto-scroll the caret a few px, and the 32px top fade band
      // would otherwise cover the still-visible first line. Real one-line scrolls
      // (~28-32px) stay well past this threshold.
      setScrollAtTop(el.scrollTop < 16)
      setScrollAtBottom(el.scrollTop + el.clientHeight >= el.scrollHeight - 2)
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    cleanupRef.current = () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
    }
  }, [elementRef])

  useEffect(() => {
    if (loading) {
      setScrollAtTop(true)
      setScrollAtBottom(true)
      cleanupRef.current?.()
      cleanupRef.current = undefined
      return
    }
    attachScrollListeners()
    return () => { cleanupRef.current?.(); cleanupRef.current = undefined }
  }, [loading, text, attachScrollListeners])

  return { scrollAtTop, scrollAtBottom, attachScrollListeners }
}
