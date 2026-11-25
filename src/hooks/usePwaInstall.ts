import { useCallback, useEffect, useState } from 'react'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

function detectStandalone(): boolean {
  if (typeof window === 'undefined') return false
  const nav = window.navigator as Navigator & { standalone?: boolean }
  if (nav.standalone === true) return true
  return typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches
}

function detectIos(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  if (/iPad|iPhone|iPod/.test(ua)) return true
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
}

export interface PwaInstallState {
  isInstalled: boolean
  canInstall: boolean
  isIosInstallable: boolean
  promptInstall: () => Promise<boolean>
}

export function usePwaInstall(): PwaInstallState {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [isInstalled, setIsInstalled] = useState(detectStandalone)

  useEffect(() => {
    const handleBeforeInstall = (event: Event) => {
      event.preventDefault()
      setDeferredPrompt(event as BeforeInstallPromptEvent)
    }
    const handleInstalled = () => {
      setDeferredPrompt(null)
      setIsInstalled(true)
    }
    const mql = typeof window.matchMedia === 'function'
      ? window.matchMedia('(display-mode: standalone)')
      : null
    const handleDisplayMode = () => {
      setIsInstalled(detectStandalone())
    }

    window.addEventListener('beforeinstallprompt', handleBeforeInstall)
    window.addEventListener('appinstalled', handleInstalled)
    mql?.addEventListener('change', handleDisplayMode)

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstall)
      window.removeEventListener('appinstalled', handleInstalled)
      mql?.removeEventListener('change', handleDisplayMode)
    }
  }, [])

  const promptInstall = useCallback(async () => {
    if (!deferredPrompt) return false
    await deferredPrompt.prompt()
    const { outcome } = await deferredPrompt.userChoice
    setDeferredPrompt(null)
    if (outcome === 'accepted') {
      setIsInstalled(true)
      return true
    }
    return false
  }, [deferredPrompt])

  const canInstall = !isInstalled && deferredPrompt !== null
  const isIosInstallable = !isInstalled && !canInstall && detectIos()

  return { isInstalled, canInstall, isIosInstallable, promptInstall }
}
