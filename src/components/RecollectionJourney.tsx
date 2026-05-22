import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { useI18n } from '../i18n'
import { todayYmd, ymd, parseYmd, diaryDateLabel, weekdayLabel, sameMonthDayInPastYears, nearestEntryWithin, consecutiveWeekStreak, consecutiveMonthStreak } from '../utils/date'
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

type Milestone =
  | { date: string; kind: 'nth'; n: number }
  | { date: string; kind: 'oneYear' }
  | { date: string; kind: 'monthStreak'; n: number }
  | { date: string; kind: 'weekStreak'; n: number }

interface PeriodicEntry {
  date: string
  eyebrow: string
}

const MILESTONE_THRESHOLDS = [1000, 500, 365, 100]

function excerpt(content: string, max = 140): string {
  const text = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean).join('  ')
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function isAtLeastOneYearBefore(date: string, today: string): boolean {
  const p = parseYmd(date)
  const ref = parseYmd(today)
  if (!p || !ref) return false
  if (ref.y - p.y > 1) return true
  if (ref.y - p.y < 1) return false
  return ref.m > p.m || (ref.m === p.m && ref.d >= p.d)
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
      const d = new Date(ref.y, ref.m - 1 - months, ref.d)
      return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate())
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

  const ascending = useMemo(() => [...dates].sort((a, b) => a.localeCompare(b)), [dates])

  const milestones = useMemo<Milestone[]>(() => {
    const result: Milestone[] = []
    for (const n of MILESTONE_THRESHOLDS) {
      if (ascending.length >= n) {
        result.push({ date: ascending[n - 1], kind: 'nth', n })
        break
      }
    }
    const oldest = ascending[0]
    if (oldest && isAtLeastOneYearBefore(oldest, today)) {
      result.push({ date: oldest, kind: 'oneYear' })
    }
    const recent = ascending[ascending.length - 1]
    if (recent) {
      const months = consecutiveMonthStreak(dates)
      const weeks = consecutiveWeekStreak(dates)
      if (months >= 2) {
        result.push({ date: recent, kind: 'monthStreak', n: months })
      } else if (weeks >= 2) {
        result.push({ date: recent, kind: 'weekStreak', n: weeks })
      }
    }
    return result
  }, [ascending, dates, today])

  const randomCandidates = useMemo(() => dates.filter(d => d !== today), [dates, today])
  const [randomDate, setRandomDate] = useState<string | null>(null)

  const pickRandom = useCallback((avoid: string | null) => {
    if (randomCandidates.length === 0) {
      setRandomDate(null)
      return
    }
    let next = randomCandidates[Math.floor(Math.random() * randomCandidates.length)]
    for (let i = 0; next === avoid && randomCandidates.length > 1 && i < 6; i++) {
      next = randomCandidates[Math.floor(Math.random() * randomCandidates.length)]
    }
    setRandomDate(next)
  }, [randomCandidates])

  useEffect(() => {
    pickRandom(null)
  }, [pickRandom])

  const [previews, setPreviews] = useState<Map<string, Preview>>(new Map())
  const previewsRef = useRef(previews)
  const loadingRef = useRef<Set<string>>(new Set())
  useEffect(() => { previewsRef.current = previews }, [previews])

  useEffect(() => {
    const targets = [
      ...onThisDay,
      ...periodic.map(p => p.date),
      ...milestones.map(m => m.date),
      ...(randomDate ? [randomDate] : []),
    ]
    const toLoad = targets.filter(d => !previewsRef.current.has(d) && !loadingRef.current.has(d))
    if (toLoad.length === 0) return

    let cancelled = false
    toLoad.forEach(d => loadingRef.current.add(d))
    Promise.all(
      toLoad.map(async d => {
        const loaded = await getContent(d).catch(() => null)
        return [d, loaded?.entry.content ?? ''] as const
      }),
    ).then(entries => {
      toLoad.forEach(d => loadingRef.current.delete(d))
      if (cancelled) return
      setPreviews(prev => {
        const next = new Map(prev)
        for (const [d, content] of entries) {
          next.set(d, { snippet: excerpt(content), hasText: Boolean(content.trim()) })
        }
        return next
      })
    })

    return () => { cancelled = true }
  }, [onThisDay, periodic, milestones, randomDate, getContent])

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

  const milestoneEyebrow = (m: Milestone): string => {
    switch (m.kind) {
      case 'nth': return t.recollection.nthDay(m.n)
      case 'oneYear': return t.recollection.oneYear
      case 'monthStreak': return t.recollection.monthStreak(m.n)
      case 'weekStreak': return t.recollection.weekStreak(m.n)
    }
  }

  const hasAnything = onThisDay.length > 0 || periodic.length > 0 || milestones.length > 0 || randomDate !== null

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
                  {renderCard(randomDate, '')}
                </div>
                {randomCandidates.length > 1 && (
                  <button className="recollection-another" onClick={() => pickRandom(randomDate)}>
                    {t.recollection.another}
                  </button>
                )}
              </section>
            )}

            {milestones.length > 0 && (
              <section className="recollection-section">
                <h3 className="recollection-section-heading">
                  <span className="recollection-section-glyph" aria-hidden="true">⚑</span>
                  {t.recollection.milestones}
                </h3>
                <div className="recollection-cards">
                  {milestones.map(m => renderCard(m.date, milestoneEyebrow(m)))}
                </div>
              </section>
            )}
          </div>
        )}
      </motion.div>
    </motion.div>
  )
}
