import { useEffect } from 'react'

const KEYBOARD_INSET_VAR = '--mobile-keyboard-inset-bottom'

// Tracks the on-screen keyboard height via visualViewport and publishes it as a
// CSS custom property on <html>, so the editor layout can lift above the mobile
// keyboard. No-op on platforms without visualViewport.
export function useKeyboardInset() {
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return

    let frameId: number | null = null

    const update = () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId)
      frameId = window.requestAnimationFrame(() => {
        frameId = null
        const inset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
        document.documentElement.style.setProperty(KEYBOARD_INSET_VAR, `${Math.round(inset)}px`)
      })
    }

    update()
    viewport.addEventListener('resize', update)
    viewport.addEventListener('scroll', update)

    return () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId)
      viewport.removeEventListener('resize', update)
      viewport.removeEventListener('scroll', update)
      document.documentElement.style.removeProperty(KEYBOARD_INSET_VAR)
    }
  }, [])
}
