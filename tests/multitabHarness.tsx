import { useMemo } from 'react'
import { createRoot } from 'react-dom/client'
import { useAuth, type AuthState } from '../src/hooks/useAuth'
import { useDiary, type DiaryState } from '../src/hooks/useDiary'
import { SyncQueueManager } from '../src/lib/syncQueue'
import { deleteEntry } from '../src/api/driveEntries'
import { getAllCached } from '../src/lib/diaryCache'

declare global {
  interface Window {
    multitabHarness: { auth: AuthState; diary: DiaryState; queue: SyncQueueManager; processQueue: () => Promise<void>; getAllCached: typeof getAllCached }
  }
}

function Harness() {
  const auth = useAuth()
  const diary = useDiary(auth.status, auth.email, auth.handleExpired)
  const queue = useMemo(() => new SyncQueueManager(auth.email ?? undefined), [auth.email])
  window.multitabHarness = { auth, diary, queue, getAllCached, processQueue: () => queue.process(async item => { await deleteEntry(item.date); return true }) }
  return <div id="ready" data-status={auth.status} data-email={auth.email} data-loaded={String(diary.freshListLoaded)} />
}
createRoot(document.getElementById('root')!).render(<Harness />)
