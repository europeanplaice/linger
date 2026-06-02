import { createRoot } from 'react-dom/client'
import '../src/styles.css'
import { CalendarView } from '../src/components/CalendarView'
import { I18nProvider } from '../src/i18n'

const theme = new URLSearchParams(location.search).get('theme')
if (theme) document.documentElement.setAttribute('data-theme', theme)

const root = createRoot(document.getElementById('root') as HTMLElement)
const selectedDates: string[] = []

root.render(
  <I18nProvider>
    <CalendarView
      dates={new Set(['2026-01-05', '2026-03-10', '2026-06-15'])}
      selectedDate="2026-04-14"
      onSelect={date => {
        selectedDates.push(date)
      }}
    />
  </I18nProvider>,
)

window.calendarHarness = {
  selectedDates: () => [...selectedDates],
}
