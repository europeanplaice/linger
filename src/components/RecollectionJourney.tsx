import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { useI18n } from '../i18n'
import { todayYmd, ymd, parseYmd, diaryDateLabel, weekdayLabel, addMonths, daysInMonth, sameMonthDayInPastYears, nearestEntryWithin } from '../utils/date'
import type { DiaryState } from '../hooks/useDiary'

interface RecollectionJourneyProps {
  dates: string[]
  getContent: DiaryState['getContent']
  onSelect: (date: string) => void
  onClose: () => void
}

interface Preview {
  snippet: string
  hasText: boolean
}

interface PeriodicEntry {
  date: string
  eyebrow: string
}

function excerpt(content: string, max = 140): string {
  const text = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean).join('  ')
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

export function RecollectionJourney({ dates, getContent, onSelect, onClose }: RecollectionJourneyProps) {
  const { t, locale } = useI18n()
  const overlayRef = useRef<HTMLDivElement>(null)
  const today = todayYmd()

  const onThisDay = useMemo(() => sameMonthDayInPastYears(dates, today), [dates, today])

  const periodic = useMemo<PeriodicEntry[]>(() => {
    const ref = parseYmd(today)
    if (!ref) return []
    const shiftDays = (days: number) => {
      const d = new Date(ref.y, ref.m - 1, ref.d)
      d.setDate(d.getDate() - days)
      return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate())
    }
    const shiftMonths = (months: number) => {
      const { year, month } = addMonths(ref.y, ref.m, -months)
      const day = Math.min(ref.d, daysInMonth(year, month))
      return ymd(year, month, day)
    }
    const specs = [
      { target: shiftDays(7), tol: 3, eyebrow: t.recollection.weekAgo(1) },
      { target: shiftMonths(1), tol: 7, eyebrow: t.recollection.monthsAgo(1) },
      { target: shiftMonths(3), tol: 8, eyebrow: t.recollection.monthsAgo(3) },
      { target: shiftMonths(6), tol: 10, eyebrow: t.recollection.monthsAgo(6) },
    ]
    const used = new Set<string>([today, ...onThisDay])
    const out: PeriodicEntry[] = []
    for (const s of specs) {
      const found = nearestEntryWithin(dates, s.target, s.tol)
      if (found && !used.has(found)) {
        used.add(found)
        out.push({ date: found, eyebrow: s.eyebrow })
      }
    }
    return out
  }, [dates, today, onThisDay, t])

  const randomCandidates = useMemo(() => {
    const exclude = new Set<string>([today, ...onThisDay, ...periodic.map(p => p.date)])
    return dates.filter(d => !exclude.has(d))
  }, [dates, today, onThisDay, periodic])

  const [randomQueue] = useState<string[]>(() => shuffle(randomCandidates))
  const [randomIdx, setRandomIdx] = useState(0)
  const randomDate = randomQueue[randomIdx] ?? null
  const nextDate = randomQueue[randomIdx + 1] ?? null

  const [previews, setPreviews] = useState<Map<string, Preview>>(new Map())
  const previewsRef = useRef(previews)
  const loadingRef = useRef<Set<string>>(new Set())
  useEffect(() => { previewsRef.current = previews }, [previews])

  useEffect(() => {
    const targets = [
      ...onThisDay,
      ...periodic.map(p => p.date),
      ...(randomDate ? [randomDate] : []),
      ...(nextDate ? [nextDate] : []),
    ]
    const toLoad = targets.filter(d => !previewsRef.current.has(d) && !loadingRef.current.has(d))
    if (toLoad.length === 0) return

    let cancelled = false
    toLoad.forEach(d => {
      loadingRef.current.add(d)
      getContent(d).catch(() => null).then(loaded => {
        loadingRef.current.delete(d)
        if (cancelled) return
        const content = loaded?.entry.content ?? ''
        setPreviews(prev => {
          const next = new Map(prev)
          next.set(d, { snippet: excerpt(content), hasText: Boolean(content.trim()) })
          return next
        })
      })
    })

    return () => { cancelled = true }
  }, [onThisDay, periodic, randomDate, nextDate, getContent])

  const handleOverlayClick = useCallback((e: React.MouseEvent) => {
    if (e.target === overlayRef.current) onClose()
  }, [onClose])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const renderCard = (date: string, eyebrow: string) => {
    const preview = previews.get(date)
    const weekday = weekdayLabel(date, locale)
    return (
      <button key={date} className="recollection-card" onClick={() => onSelect(date)}>
        <span className="recollection-card-eyebrow">{eyebrow}</span>
        <span className="recollection-card-date">
          {diaryDateLabel(date, true, 'long', locale)}
          {weekday && <span className="recollection-card-weekday">{weekday}</span>}
        </span>
        <span className="recollection-card-snippet">
          {preview === undefined ? (
            <span className="recollection-card-skeleton" />
          ) : preview.hasText ? (
            preview.snippet
          ) : (
            <span className="recollection-card-empty">{t.recollection.noText}</span>
          )}
        </span>
      </button>
    )
  }

  const hasAnything = onThisDay.length > 0 || periodic.length > 0 || randomDate !== null

  return (
    <motion.div
      className="recollection-overlay"
      ref={overlayRef}
      onClick={handleOverlayClick}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.22 }}
    >
      <motion.div
        className="recollection-view"
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 10 }}
        transition={{ type: 'spring', stiffness: 360, damping: 34 }}
      >
        <div className="recollection-header">
          <h2 className="recollection-title">{t.recollection.title}</h2>
          <button className="recollection-close" onClick={onClose} aria-label={t.recollection.close}>×</button>
        </div>

        {!hasAnything ? (
          <p className="recollection-empty">{t.recollection.empty}</p>
        ) : (
          <div className="recollection-sections">
            {onThisDay.length > 0 && (
              <section className="recollection-section">
                <h3 className="recollection-section-heading">
                  <span className="recollection-section-glyph" aria-hidden="true">⚬</span>
                  {t.recollection.onThisDay}
                </h3>
                <div className="recollection-cards">
                  {onThisDay.map(date => {
                    const p = parseYmd(date)
                    const ref = parseYmd(today)
                    const years = p && ref ? ref.y - p.y : 0
                    return renderCard(date, t.recollection.yearsAgo(years))
                  })}
                </div>
              </section>
            )}

            {periodic.length > 0 && (
              <section className="recollection-section">
                <h3 className="recollection-section-heading">
                  <span className="recollection-section-glyph" aria-hidden="true">◷</span>
                  {t.recollection.aWhileAgo}
                </h3>
                <div className="recollection-cards">
                  {periodic.map(p => renderCard(p.date, p.eyebrow))}
                </div>
              </section>
            )}

            {randomDate && (
              <section className="recollection-section">
                <h3 className="recollection-section-heading">
                  <span className="recollection-section-glyph" aria-hidden="true">✦</span>
                  {t.recollection.serendipity}
                </h3>
                <div className="recollection-cards">
                  {renderCard(randomDate, (() => {
                    const p = parseYmd(randomDate)
                    const r = parseYmd(today)
                    if (!p || !r) return ''
                    const days = Math.round((new Date(r.y, r.m - 1, r.d).getTime() - new Date(p.y, p.m - 1, p.d).getTime()) / 86400000)
                    return days > 0 ? t.recollection.daysAgo(days) : ''
                  })())}
                </div>
                {randomIdx < randomQueue.length - 1 && (
                  <button className="recollection-another" onClick={() => setRandomIdx(i => i + 1)}>
                    {t.recollection.another}
                  </button>
                )}
              </section>
            )}
          </div>
        )}
      </motion.div>
    </motion.div>
  )
}
