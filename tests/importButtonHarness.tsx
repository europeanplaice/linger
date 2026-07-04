import { createRoot } from 'react-dom/client'
import { ImportButton } from '../src/components/ImportButton'
import { I18nProvider } from '../src/i18n'
import '../src/styles.css'

type Entry = { date: string; content: string }
type ImportResult = { imported: string[]; skipped: string[]; failed: string[] }

const root = createRoot(document.getElementById('root') as HTMLElement)
let renderCount = 0
let importCalls: Entry[][] = []
let progressCalls: { done: number; total: number }[] = []
let existingDates: string[] = []
let result: ImportResult = { imported: [], skipped: [], failed: [] }
let delayMs = 0
let shouldReject = false

function App() {
  async function handleImport(entries: Entry[], onProgress: (done: number, total: number) => void): Promise<ImportResult> {
    importCalls.push(entries)
    progressCalls = []
    if (shouldReject) throw new Error('Session expired')
    for (let i = 0; i < entries.length; i++) {
      if (delayMs) await new Promise(r => setTimeout(r, delayMs))
      const progress = { done: i + 1, total: entries.length }
      progressCalls.push(progress)
      onProgress(progress.done, progress.total)
    }
    return result
  }

  return (
    <I18nProvider>
      <ImportButton existingDates={existingDates} onImport={handleImport} />
    </I18nProvider>
  )
}

window.importButtonHarness = {
  render: (opts = {}) => {
    existingDates = opts.existingDates ?? []
    result = opts.result ?? { imported: [], skipped: [], failed: [] }
    delayMs = opts.delayMs ?? 0
    shouldReject = opts.reject ?? false
    importCalls = []
    progressCalls = []
    root.render(<App key={++renderCount} />)
  },
  importCalls: () => importCalls.map(c => [...c]),
  progressCalls: () => [...progressCalls],
}
