import { useState, useCallback } from 'react'
import { createRoot } from 'react-dom/client'
import { SettingsModal } from '../src/components/SettingsModal'
import type { AccentColor } from '../src/hooks/useAccentColor'
import type { FontSize } from '../src/hooks/useFontSize'
import type { HolidayCountry } from '../src/utils/holidays'
import {
  MAX_MILESTONES,
  MAX_MILESTONE_BADGES,
  type Milestone,
} from '../src/types'
import { I18nProvider } from '../src/i18n'
import { useS3Backfill } from '../src/hooks/useS3Backfill'
import '../src/styles.css'

type ExportCall = { hasProgress: boolean }[]

const root = createRoot(document.getElementById('root') as HTMLElement)

type ImportCall = { count: number; hasProgress: boolean }

const exportCalls: ExportCall = []
const importCalls: ImportCall[] = []
let exportReject = false
let signOutCount = 0
let renderCount = 0

interface AppProps {
  autoSave: boolean
  modalOpen: boolean
  themeMode: 'light' | 'dark' | 'system'
  accentColor: AccentColor
  fontSize: FontSize
  email?: string
  milestones?: Milestone[]
}

function App({ autoSave: initialAutoSave, modalOpen: initialOpen, themeMode: initialTheme, accentColor: initialAccent, fontSize: initialFontSize, email, milestones: initialMilestones = [] }: AppProps) {
  const [autoSave, setAutoSave] = useState(initialAutoSave)
  const [open, setOpen] = useState(initialOpen)
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>(initialTheme)
  const [accent, setAccent] = useState<AccentColor>(initialAccent)
  const [font, setFont] = useState<'serif' | 'sans'>('serif')
  const [fontSize, setFontSize] = useState<FontSize>(initialFontSize)
  const [holidayCountry, setHolidayCountry] = useState<HolidayCountry>('off')
  const [milestones, setMilestones] = useState(initialMilestones)
  // Mirrors App.tsx: the harness has no real sign-in flow, so this is always "on" —
  // matching the real app's App-level (not Settings-modal-level) backfill wiring.
  const s3Backfill = useS3Backfill(true)

  const handleAutoSaveToggle = useCallback(() => {
    setAutoSave(prev => {
      const next = !prev
      localStorage.setItem('linger_autosave', String(next))
      return next
    })
  }, [])

  const handleExport = useCallback(async (onProgress: (done: number, total: number) => void) => {
    exportCalls.push({ hasProgress: typeof onProgress === 'function' })
    if (exportReject) throw new Error('Export failed')
    return []
  }, [])

  const handleImport = useCallback(async (
    entries: { date: string; content: string }[],
    onProgress: (done: number, total: number) => void,
  ) => {
    importCalls.push({ count: entries.length, hasProgress: typeof onProgress === 'function' })
    entries.forEach((_, i) => onProgress(i + 1, entries.length))
    return { imported: entries.map(e => e.date), skipped: [], failed: [] }
  }, [])

  return (
    <>
      <button id="open-settings" onClick={() => setOpen(true)}>Open Settings</button>
      {open && (
        <SettingsModal
          autoSave={autoSave}
          onAutoSaveToggle={handleAutoSaveToggle}
          themeMode={theme}
          onThemeModeChange={setTheme}
          accentColor={accent}
          onAccentChange={(c) => {
            localStorage.setItem('linger_accent', c)
            setAccent(c)
          }}
          fontMode={font}
          onFontToggle={() => setFont(f => f === 'serif' ? 'sans' : 'serif')}
          fontSize={fontSize}
          onFontSizeChange={setFontSize}
          holidayCountry={holidayCountry}
          onHolidayCountryChange={setHolidayCountry}
          dates={['2026-05-01', '2026-05-02']}
          onExport={handleExport}
          onImport={handleImport}
          onClose={() => setOpen(false)}
          onSignOut={() => { signOutCount++ }}
          email={email}
          milestones={milestones}
          onMilestoneAdd={(label, date, emoji) => {
            setMilestones(prev => {
              if (prev.length >= MAX_MILESTONES) return prev
              const enabledBadges = prev.filter(a => a.showBadge !== false).length
              return [
                ...prev,
                {
                  id: `milestone-${prev.length + 1}`,
                  label,
                  date,
                  ...(emoji ? { emoji } : {}),
                  ...(enabledBadges >= MAX_MILESTONE_BADGES ? { showBadge: false } : {}),
                },
              ]
            })
          }}
          onMilestoneUpdate={(id, label, date, emoji) => setMilestones(prev => prev.map(a =>
            a.id === id ? { ...a, label, date, ...(emoji ? { emoji } : { emoji: undefined }) } : a
          ))}
          onMilestoneRemove={id => setMilestones(prev => prev.filter(a => a.id !== id))}
          onMilestoneToggleBadge={id => setMilestones(prev => {
            const target = prev.find(a => a.id === id)
            if (
              target?.showBadge === false
              && prev.filter(a => a.showBadge !== false).length >= MAX_MILESTONE_BADGES
            ) {
              return prev
            }
            return prev.map(a => (
              a.id === id ? { ...a, showBadge: a.showBadge === false ? undefined : false } : a
            ))
          })}
          s3BackfillProgress={s3Backfill.backfillProgress}
          s3LastSyncError={s3Backfill.lastSyncError}
          s3LastSyncErrorAt={s3Backfill.lastSyncErrorAt}
          s3BackfillActive={s3Backfill.backfillActive}
          onS3StartBackfill={s3Backfill.startBackfill}
          onS3ClearSyncError={s3Backfill.clearSyncError}
        />
      )}
    </>
  )
}

window.settingsHarness = {
  render: ({ autoSave: initialAutoSave, modalOpen: initialOpen, themeMode: initialTheme, accentColor: initialAccent, fontSize: initialFontSize, email, milestones }: { autoSave?: boolean; modalOpen?: boolean; themeMode?: 'light' | 'dark' | 'system'; accentColor?: AccentColor; fontSize?: FontSize; email?: string; milestones?: Milestone[] } = {}) => {
    exportCalls.splice(0)
    importCalls.splice(0)
    exportReject = false
    signOutCount = 0
    root.render(
      <I18nProvider>
        <App
          autoSave={initialAutoSave ?? true}
          modalOpen={initialOpen ?? true}
          themeMode={initialTheme ?? 'light'}
          accentColor={initialAccent ?? 'indigo'}
          fontSize={initialFontSize ?? 'md'}
          email={email}
          milestones={milestones}
          key={++renderCount}
        />
      </I18nProvider>
    )
  },
  getStoredAutoSave: () => localStorage.getItem('linger_autosave'),
  getStoredTheme: () => localStorage.getItem('linger_theme'),
  exportCalls: () => [...exportCalls],
  importCalls: () => [...importCalls],
  setExportReject: (v: boolean) => { exportReject = v },
  signOutCount: () => signOutCount,
}
