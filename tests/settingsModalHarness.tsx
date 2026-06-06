import { useState, useCallback } from 'react'
import { createRoot } from 'react-dom/client'
import { SettingsModal } from '../src/components/SettingsModal'
import type { FontSize } from '../src/hooks/useFontSize'
import { I18nProvider } from '../src/i18n'
import '../src/styles.css'

type ExportCall = { hasProgress: boolean }[]

const root = createRoot(document.getElementById('root') as HTMLElement)

const exportCalls: ExportCall = []
let exportReject = false
let renderCount = 0

interface AppProps {
  autoSave: boolean
  modalOpen: boolean
  themeMode: 'light' | 'dark' | 'system'
  fontSize: FontSize
  email?: string
}

function App({ autoSave: initialAutoSave, modalOpen: initialOpen, themeMode: initialTheme, fontSize: initialFontSize, email }: AppProps) {
  const [autoSave, setAutoSave] = useState(initialAutoSave)
  const [open, setOpen] = useState(initialOpen)
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>(initialTheme)
  const [font, setFont] = useState<'serif' | 'sans'>('serif')
  const [fontSize, setFontSize] = useState<FontSize>(initialFontSize)

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
          dates={['2026-05-01', '2026-05-02']}
          onExport={handleExport}
          onClose={() => setOpen(false)}
          onSignOut={() => {}}
          email={email}
        />
      )}
    </>
  )
}

window.settingsHarness = {
  render: ({ autoSave: initialAutoSave, modalOpen: initialOpen, themeMode: initialTheme, fontSize: initialFontSize, email }: { autoSave?: boolean; modalOpen?: boolean; themeMode?: 'light' | 'dark' | 'system'; fontSize?: FontSize; email?: string } = {}) => {
    exportCalls.splice(0)
    exportReject = false
    root.render(
      <I18nProvider>
        <App
          autoSave={initialAutoSave ?? true}
          modalOpen={initialOpen ?? true}
          themeMode={initialTheme ?? 'light'}
          fontSize={initialFontSize ?? 'md'}
          email={email}
          key={++renderCount}
        />
      </I18nProvider>
    )
  },
  getStoredAutoSave: () => localStorage.getItem('linger_autosave'),
  getStoredTheme: () => localStorage.getItem('linger_theme'),
  exportCalls: () => [...exportCalls],
  setExportReject: (v: boolean) => { exportReject = v },
}
