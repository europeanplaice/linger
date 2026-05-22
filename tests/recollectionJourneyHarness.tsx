import { createRoot } from 'react-dom/client'
import { RecollectionJourney } from '../src/components/RecollectionJourney'
import { I18nProvider } from '../src/i18n'
import type { LoadedDiaryEntry } from '../src/types'
import '../src/styles.css'

const root = createRoot(document.getElementById('root') as HTMLElement)

const selectedDates: string[] = []
let closeCount = 0

function makeLoaded(date: string, content: string): LoadedDiaryEntry {
  return {
    entry: { date, content, updated_at: '2026-01-01T00:00:00.000Z' },
    meta: { id: `id-${date}`, name: `diary-${date}.md`, version: '1' },
  }
}

window.recollectionHarness = {
  render: ({ dates, contents }: { dates: string[]; contents?: Record<string, string> }) => {
    selectedDates.splice(0)
    closeCount = 0
    const map = contents ?? {}
    root.render(
      <I18nProvider>
        <RecollectionJourney
          dates={dates}
          getContent={async (date: string) => {
            const content = map[date]
            return content === undefined ? null : makeLoaded(date, content)
          }}
          onSelect={(d: string) => { selectedDates.push(d) }}
          onClose={() => { closeCount += 1 }}
          key={Date.now()}
        />
      </I18nProvider>,
    )
  },
  selectedDates: () => [...selectedDates],
  closeCount: () => closeCount,
}
