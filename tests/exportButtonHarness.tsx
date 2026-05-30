import { createRoot } from 'react-dom/client'
import { ExportButton } from '../src/components/ExportButton'
import { I18nProvider } from '../src/i18n'
import '../src/styles.css'

const entries = [
  {
    date: '2026-05-01',
    content: '---\ndate: 2026-05-01\n---\n\nfirst entry',
  },
  {
    date: '2026-05-02',
    content: '---\ndate: 2026-05-02\n---\n\nsecond entry',
  },
]

const root = createRoot(document.getElementById('root') as HTMLElement)
let renderCount = 0
let exportCalls = 0
let progressCalls: { done: number; total: number }[] = []

function App() {
  async function handleExport(onProgress: (done: number, total: number) => void) {
    exportCalls += 1
    progressCalls = []
    entries.forEach((_, index) => {
      const progress = { done: index + 1, total: entries.length }
      progressCalls.push(progress)
      onProgress(progress.done, progress.total)
    })
    return entries
  }

  return (
    <I18nProvider>
      <ExportButton dates={entries.map(entry => entry.date)} onExport={handleExport} />
    </I18nProvider>
  )
}

window.exportButtonHarness = {
  render: () => {
    exportCalls = 0
    progressCalls = []
    root.render(<App key={++renderCount} />)
  },
  exportCalls: () => exportCalls,
  progressCalls: () => [...progressCalls],
}
