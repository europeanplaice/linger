import { useEffect, useState, useRef, useMemo } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ChevronDown } from 'lucide-react'
import { todayYmd, ymd, daysInMonth as daysInMonthUtil, parseYmd } from '../utils/date'
import { useI18n } from '../i18n'

interface Props {
  dates: Set<string>
  selectedDate: string
  onSelect: (date: string) => void
}

interface MonthYearPickerProps {
  year: number
  month: number
  yearOptions: number[]
  months: string[]
  dates: Set<string>
  onSelect: (year: number, month: number) => void
}

function MonthYearPicker({ year, month, yearOptions, months, dates, onSelect }: MonthYearPickerProps) {
  const [open, setOpen] = useState(false)
  const [pickerYear, setPickerYear] = useState(year)

  const entryMonths = useMemo(() => {
    const s = new Set<string>()
    for (const d of dates) s.add(d.slice(0, 7))
    return s
  }, [dates])
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => { setPickerYear(year) }, [year])

  useEffect(() => {
    if (!open) return
    const onPointer = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const minYear = yearOptions[0]
  const maxYear = yearOptions[yearOptions.length - 1]

  return (
    <div className="mypicker" ref={ref}>
      <button
        type="button"
        className="mypicker-trigger"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        {months[month]} {year}
        <ChevronDown size={11} className={`mypicker-chevron${open ? ' open' : ''}`} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            className="mypicker-popup"
            initial={{ opacity: 0, y: -6, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.95 }}
            transition={{ duration: 0.14, ease: 'easeOut' }}
          >
            <div className="mypicker-year-nav">
              <button
                type="button"
                onClick={() => setPickerYear(y => Math.max(y - 1, minYear))}
                disabled={pickerYear <= minYear}
                aria-label="Previous year"
              >‹</button>
              <span className="mypicker-year-label">{pickerYear}</span>
              <button
                type="button"
                onClick={() => setPickerYear(y => Math.min(y + 1, maxYear))}
                disabled={pickerYear >= maxYear}
                aria-label="Next year"
              >›</button>
            </div>
            <div className="mypicker-months">
              {months.map((name, i) => {
                const mm = String(i + 1).padStart(2, '0')
                const hasEntry = entryMonths.has(`${pickerYear}-${mm}`)
                return (
                  <button
                    key={name}
                    type="button"
                    className={`mypicker-month-btn${i === month && pickerYear === year ? ' active' : ''}`}
                    onClick={() => { onSelect(pickerYear, i); setOpen(false) }}
                  >
                    {name.slice(0, 3)}
                    <span className={`mypicker-dot${hasEntry ? ' visible' : ''}`} aria-hidden="true" />
                  </button>
                )
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

const gridVariants = {
  enter: (dir: number) => ({ x: dir * 16, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (dir: number) => ({ x: dir * -16, opacity: 0 }),
}

export function CalendarView({ dates, selectedDate, onSelect }: Props) {
  const { t } = useI18n()
  const [todayStr, setTodayStr] = useState(todayYmd)
  const todayRef = useRef(todayStr)
  todayRef.current = todayStr
  const directionRef = useRef(0)

  useEffect(() => {
    const tick = () => {
      const next = todayYmd()
      if (next !== todayRef.current) {
        todayRef.current = next
        setTodayStr(next)
      }
    }
    const id = setInterval(tick, 60_000)
    return () => clearInterval(id)
  }, [])

  const todayParsed = parseYmd(todayStr)
  const selectedParsed = parseYmd(selectedDate)
  const todayYear = todayParsed?.y ?? 0
  const [year, setYear] = useState(selectedParsed?.y ?? todayYear)
  const [month, setMonth] = useState((selectedParsed?.m ?? todayParsed?.m ?? 1) - 1)
  const yearMonthRef = useRef({ year, month })
  yearMonthRef.current = { year, month }

  const setDirectionFor = (newY: number, newM: number) => {
    const { year: curY, month: curM } = yearMonthRef.current
    const cur = curY * 12 + curM
    const tgt = newY * 12 + newM
    directionRef.current = tgt > cur ? 1 : tgt < cur ? -1 : 0
  }

  useEffect(() => {
    if (!selectedParsed) return
    setDirectionFor(selectedParsed.y, selectedParsed.m - 1)
    setYear(selectedParsed.y)
    setMonth(selectedParsed.m - 1)
  }, [selectedParsed?.y, selectedParsed?.m])

  const firstDay = new Date(year, month, 1).getDay()
  const daysInMonth = daysInMonthUtil(year, month + 1)
  const entryDates = [...dates]
    .filter(date => parseYmd(date))
    .sort((a, b) => a.localeCompare(b))
  const yearOptions = (() => {
    const entryYears = entryDates
      .map(date => parseYmd(date)?.y)
      .filter((entryYear): entryYear is number => entryYear !== undefined)
    const minYear = Math.min(todayYear - 100, selectedParsed?.y ?? todayYear, ...entryYears)
    const maxYear = Math.max(todayYear + 10, selectedParsed?.y ?? todayYear, ...entryYears)

    return Array.from({ length: maxYear - minYear + 1 }, (_, index) => minYear + index)
  })()

  const prev = () => {
    directionRef.current = -1
    if (month === 0) { setYear(y => y - 1); setMonth(11) }
    else setMonth(m => m - 1)
  }
  const next = () => {
    directionRef.current = 1
    if (month === 11) { setYear(y => y + 1); setMonth(0) }
    else setMonth(m => m + 1)
  }
  const goToToday = () => {
    if (todayParsed) {
      setDirectionFor(todayParsed.y, todayParsed.m - 1)
      setYear(todayParsed.y)
      setMonth(todayParsed.m - 1)
    }
  }

  const cells: (number | null)[] = [...Array(firstDay).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1)]
  while (cells.length < 42) cells.push(null)

  return (
    <div className="calendar">
      <div className="calendar-nav">
        <button type="button" onClick={prev} aria-label={t.calendar.previousMonth}>‹</button>
        <div className="calendar-title">
          <MonthYearPicker
            year={year}
            month={month}
            yearOptions={yearOptions}
            months={t.calendar.months}
            dates={dates}
            onSelect={(newYear, newMonth) => {
              setDirectionFor(newYear, newMonth)
              setYear(newYear)
              setMonth(newMonth)
            }}
          />
        </div>
        <button type="button" onClick={next} aria-label={t.calendar.nextMonth}>›</button>
      </div>
      <div className="calendar-today-row">
        <button type="button" className="today-btn" onClick={goToToday} aria-label={t.calendar.goToCurrentMonth}>{t.calendar.currentMonth}</button>
      </div>
      <div className="calendar-grid-wrap">
        <AnimatePresence mode="popLayout" custom={directionRef.current} initial={false}>
          <motion.div
            key={`${year}-${month}`}
            className="calendar-grid"
            custom={directionRef.current}
            variants={gridVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{
              x: { duration: 0.2, ease: 'easeOut' },
              opacity: { duration: 0.12 },
            }}
          >
            {t.calendar.days.map(d => <div key={d} className="cal-day-label">{d}</div>)}
            {cells.map((day, i) => {
              if (day === null) return (
                <div key={`empty-${i}`} className="cal-day cal-day-empty" aria-hidden="true">
                  <span>&nbsp;</span>
                  <span className="dot" />
                </div>
              )
              const dateStr = ymd(year, month + 1, day)
              const hasEntry = dates.has(dateStr)
              const isSelected = dateStr === selectedDate
              const isToday = dateStr === todayStr
              return (
                <motion.button
                  key={dateStr}
                  type="button"
                  aria-label={dateStr}
                  className={['cal-day', hasEntry ? 'has-entry' : '', isSelected ? 'selected' : '', isToday ? 'today' : ''].filter(Boolean).join(' ')}
                  onClick={() => onSelect(dateStr)}
                  whileTap={{ scale: 0.92 }}
                  transition={{ type: 'spring', stiffness: 600, damping: 25 }}
                >
                  {day}
                  <span className="dot" aria-hidden="true" />
                </motion.button>
              )
            })}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  )
}
