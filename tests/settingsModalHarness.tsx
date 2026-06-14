import { useState, useCallback } from 'react'
import { createRoot } from 'react-dom/client'
import { SettingsModal } from '../src/components/SettingsModal'
import type { FontSize } from '../src/hooks/useFontSize'
import type { HolidayCountry } from '../src/utils/holidays'
import {
  MAX_MILESTONES,
  MAX_MILESTONE_BADGES,
  type Milestone,
} from '../src/types'
import { I18nProvider } from '../src/i18n'
import '../src/styles.css'

type ExportCall = { hasProgress: boolean }[]

const root = createRoot(document.getElementById('root') as HTMLElement)

const exportCalls: ExportCall = []
let exportReject = false
let signOutCount = 0
let renderCount = 0

interface AppProps {
  autoSave: boolean
  modalOpen: boolean
  themeMode: 'light' | 'dark' | 'system'
  fontSize: FontSize
  email?: string
  milestones?: Milestone[]
}

function App({ autoSave: initialAutoSave, modalOpen: initialOpen, themeMode: initialTheme, fontSize: initialFontSize, email, milestones: initialMilestones = [] }: AppProps) {
  const [autoSave, setAutoSave] = useState(initialAutoSave)
  const [open, setOpen] = useState(initialOpen)
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>(initialTheme)
  const [font, setFont] = useState<'serif' | 'sans'>('serif')
  const [fontSize, setFontSize] = useState<FontSize>(initialFontSize)
  const [holidayCountry, setHolidayCountry] = useState<HolidayCountry>('off')
  const [milestones, setMilestones] = useState(initialMilestones)

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

  return (
    <>
      <button id="open-settings" onClick={() => setOpen(true)}>Open Settings</button>
      {open && (
        <SettingsModal
          autoSave={autoSave}
          onAutoSaveToggle={handleAutoSaveToggle}
          themeMode={theme}
          onThemeModeChange={setTheme}
          fontMode={font}
          onFontToggle={() => setFont(f => f === 'serif' ? 'sans' : 'serif')}
          fontSize={fontSize}
          onFontSizeChange={setFontSize}
          holidayCountry={holidayCountry}
          onHolidayCountryChange={setHolidayCountry}
          dates={['2026-05-01', '2026-05-02']}
          onExport={handleExport}
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
        />
      )}
    </>
  )
}

window.settingsHarness = {
  render: ({ autoSave: initialAutoSave, modalOpen: initialOpen, themeMode: initialTheme, fontSize: initialFontSize, email, milestones }: { autoSave?: boolean; modalOpen?: boolean; themeMode?: 'light' | 'dark' | 'system'; fontSize?: FontSize; email?: string; milestones?: Milestone[] } = {}) => {
    exportCalls.splice(0)
    exportReject = false
    signOutCount = 0
    root.render(
      <I18nProvider>
        <App
          autoSave={initialAutoSave ?? true}
          modalOpen={initialOpen ?? true}
          themeMode={initialTheme ?? 'light'}
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
  setExportReject: (v: boolean) => { exportReject = v },
  signOutCount: () => signOutCount,
}
