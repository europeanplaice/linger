import { useEffect, useState } from 'react'
import { getCurrentDiaryFolderSharing } from '../api/diaryFolders'
import type { DiaryFolderSharing } from '../types'

export function useDiaryFolderSharing(userId: string | null): DiaryFolderSharing | null {
  const [result, setResult] = useState<{ userId: string; sharing: DiaryFolderSharing | null } | null>(null)
  useEffect(() => {
    if (!userId) return
    const controller = new AbortController()
    let checking = false
    let lastChecked = -Infinity
    const check = async () => {
      if (checking || document.visibilityState === 'hidden' || !navigator.onLine || Date.now() - lastChecked < 5000) return
      checking = true
      lastChecked = Date.now()
      try {
        const sharing = await getCurrentDiaryFolderSharing(controller.signal)
        if (!controller.signal.aborted) {
          setResult(previous => previous?.userId === userId && previous.sharing === sharing ? previous : { userId, sharing })
        }
      } catch {
        // Keep an existing warning through a connection failure.
      } finally { checking = false }
    }
    void check()
    const interval = window.setInterval(check, 60_000)
    window.addEventListener('focus', check)
    window.addEventListener('online', check)
    document.addEventListener('visibilitychange', check)
    return () => {
      controller.abort()
      window.clearInterval(interval)
      window.removeEventListener('focus', check)
      window.removeEventListener('online', check)
      document.removeEventListener('visibilitychange', check)
    }
  }, [userId])
  return result?.userId === userId ? result.sharing : null
}
