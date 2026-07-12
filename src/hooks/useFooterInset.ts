import { useEffect } from 'react'
import type { RefObject } from 'react'

const FOOTER_INSET_VAR = '--editor-footer-inset'

// Measures the rendered height of the editor's trailing content (char count,
// "need an idea?" trigger/card) and publishes it as a CSS custom property, so
// the fixed mobile action buttons (Today FAB) can reserve enough clearance
// above it dynamically instead of guessing a static offset — the idea card in
// particular varies a lot in height depending on its content.
export function useFooterInset(elementRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = elementRef.current
    if (!el) return

    const update = () => {
      document.documentElement.style.setProperty(FOOTER_INSET_VAR, `${Math.round(el.getBoundingClientRect().height)}px`)
    }

    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)

    return () => {
      ro.disconnect()
      document.documentElement.style.removeProperty(FOOTER_INSET_VAR)
    }
  }, [elementRef])
}
