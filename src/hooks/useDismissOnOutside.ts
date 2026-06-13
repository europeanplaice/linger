import { useEffect } from 'react'
import type { RefObject } from 'react'

// Dismisses a popover when, while `active`, the user clicks outside
// `containerRef` or presses Escape. `onDismiss` should be stable.
export function useDismissOnOutside<T extends HTMLElement>(
  containerRef: RefObject<T | null>,
  active: boolean,
  onDismiss: () => void,
) {
  useEffect(() => {
    if (!active) return
    const handleMouse = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) onDismiss()
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss()
    }
    document.addEventListener('mousedown', handleMouse)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleMouse)
      document.removeEventListener('keydown', handleKey)
    }
  }, [active, containerRef, onDismiss])
}
