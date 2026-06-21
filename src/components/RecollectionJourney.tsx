import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { haptics } from '../utils/haptics'
import { useI18n } from '../i18n'
import { todayYmd, parseYmd, diaryDateLabel, weekdayLabel, sameMonthDayInPastYears, nearestWithDistance } from '../utils/date'
import { buildPeriodicSpecs } from '../utils/recollectionDates'
import type { PeriodicKind } from '../utils/recollectionDates'
import { weightedOrder } from '../utils/serendipityWeights'
import { loadSeen, recordSeen } from '../utils/serendipitySeen'
import type { DiaryState } from '../hooks/useDiary'

interface RecollectionJourneyProps {
  dates: string[]
  getContent: DiaryState['getContent']
  serendipityPrefetch?: readonly string[]
  onSelect: (date: string) => void
  onClose: () => void
  getSimilar?: (date: string, limit?: number) => string[]
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

const cardContainerVariants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.05, delayChildren: 0.12 } },
}

const cardItemVariants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.28, ease: [0.22, 0.61, 0.36, 1] as [number, number, number, number] } },
}

export function RecollectionJourney({ dates, getContent, serendipityPrefetch, onSelect, onClose, getSimilar }: RecollectionJourneyProps) {
  const { t, locale } = useI18n()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const today = todayYmd()

  const onThisDay = useMemo(() => sameMonthDayInPastYears(dates, today), [dates, today])

  const periodic = useMemo<PeriodicEntry[]>(() => {
    const labelFor = (kind: PeriodicKind, approx: boolean): string => {
      switch (kind) {
        case 'week':   return t.recollection.weekAgo(1, approx)
        case 'month1': return t.recollection.monthsAgo(1, approx)
        case 'month6': return t.recollection.monthsAgo(6, approx)
        case 'year1':  return t.recollection.yearsAgo(1, approx)
        case 'year5':  return t.recollection.yearsAgo(5, approx)
        case 'year10': return t.recollection.yearsAgo(10, approx)
        case 'year20': return t.recollection.yearsAgo(20, approx)
      }
    }

    // Years already shown in On This Day — skip periodic specs for the same year
    const onThisDayYears = new Set(
      onThisDay.map(d => parseYmd(d)?.y).filter((y): y is number => y !== undefined)
    )

    const specs = buildPeriodicSpecs(dates, today)
    const used = new Set<string>([today, ...onThisDay])
    const out: PeriodicEntry[] = []

    for (const s of specs) {
      if (s.yearTarget !== undefined && onThisDayYears.has(s.yearTarget)) continue
      const found = nearestWithDistance(dates, s.target, s.tol)
      if (found && !used.has(found.date)) {
        used.add(found.date)
        out.push({ date: found.date, eyebrow: labelFor(s.kind, found.distance > 0) })
      }
    }

    return out.slice(0, 3)
  }, [dates, today, onThisDay, t])

  const randomCandidates = useMemo(() => {
    const exclude = new Set<string>([today, ...onThisDay, ...periodic.map(p => p.date)])
    return dates.filter(d => !exclude.has(d))
  }, [dates, today, onThisDay, periodic])

  const [randomQueue] = useState<string[]>(() => {
    const q = weightedOrder(randomCandidates, { today, recentlyShown: loadSeen() })
    const pinned = (serendipityPrefetch ?? []).filter(d => randomCandidates.includes(d))
    for (let i = pinned.length - 1; i >= 0; i--) {
      const idx = q.indexOf(pinned[i])
      if (idx > 0) { q.splice(idx, 1); q.unshift(pinned[i]) }
    }
    return q
  })
  const [randomIdx, setRandomIdx] = useState(0)
  const randomDate = randomQueue[randomIdx] ?? null
  const nextDate1 = randomQueue[randomIdx + 1] ?? null
  const nextDate2 = randomQueue[randomIdx + 2] ?? null
  const nextDate3 = randomQueue[randomIdx + 3] ?? null

  const shownDates = useMemo(() => {
    const s = new Set([today, ...onThisDay, ...periodic.map(p => p.date)])
    if (randomDate) s.add(randomDate)
    return s
  }, [today, onThisDay, periodic, randomDate])

  const similarDates = useMemo(() => {
    if (!randomDate || !getSimilar) return []
    return getSimilar(randomDate, 3).filter(d => !shownDates.has(d))
  }, [randomDate, getSimilar, shownDates])

  // Remember which serendipity day was surfaced so reopening avoids an immediate repeat.
  useEffect(() => {
    if (randomDate) recordSeen(randomDate)
  }, [randomDate])

  const [previews, setPreviews] = useState<Map<string, Preview>>(new Map())
  const previewsRef = useRef(previews)
  const loadingRef = useRef<Set<string>>(new Set())
  useEffect(() => { previewsRef.current = previews }, [previews])

  useEffect(() => {
    const targets = [
      ...onThisDay,
      ...periodic.map(p => p.date),
      ...(randomDate ? [randomDate] : []),
      ...[nextDate1, nextDate2, nextDate3].filter(Boolean) as string[],
      ...similarDates,
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
  }, [onThisDay, periodic, randomDate, nextDate1, nextDate2, nextDate3, similarDates, getContent])

  useEffect(() => {
    const dialog = dialogRef.current!
    dialog.showModal()
    return () => { if (dialog.open) dialog.close() }
  }, [])

  const handleCancel = useCallback((e: React.SyntheticEvent) => {
    e.preventDefault()
    onClose()
  }, [onClose])

  const handleBackdropClick = useCallback((e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target === dialogRef.current) onClose()
  }, [onClose])

  const renderCard = (date: string, eyebrow: string) => {
    const preview = previews.get(date)
    const weekday = weekdayLabel(date, locale)
    return (
      <motion.button key={date} className="recollection-card" onClick={() => { haptics.tap(); onSelect(date) }} variants={cardItemVariants}>
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
      </motion.button>
    )
  }

  const hasAnything = onThisDay.length > 0 || periodic.length > 0 || randomDate !== null

  return (
    <motion.dialog
      ref={dialogRef}
      className="recollection-dialog"
      aria-labelledby="recollection-title"
      onCancel={handleCancel}
      onClick={handleBackdropClick}
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 10 }}
      transition={{ type: 'spring', stiffness: 360, damping: 34 }}
    >
        <div className="recollection-header">
          <h2 className="recollection-title" id="recollection-title">{t.recollection.title}</h2>
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
                <motion.div className="recollection-cards" variants={cardContainerVariants} initial="hidden" animate="visible">
                  {onThisDay.map(date => {
                    const p = parseYmd(date)
                    const ref = parseYmd(today)
                    const years = p && ref ? ref.y - p.y : 0
                    return renderCard(date, t.recollection.yearsAgo(years))
                  })}
                </motion.div>
              </section>
            )}

            {periodic.length > 0 && (
              <section className="recollection-section">
                <h3 className="recollection-section-heading">
                  <span className="recollection-section-glyph" aria-hidden="true">◷</span>
                  {t.recollection.aWhileAgo}
                </h3>
                <motion.div className="recollection-cards" variants={cardContainerVariants} initial="hidden" animate="visible">
                  {periodic.map(p => renderCard(p.date, p.eyebrow))}
                </motion.div>
              </section>
            )}

            {randomDate && (
              <section className="recollection-section">
                <h3 className="recollection-section-heading">
                  <span className="recollection-section-glyph" aria-hidden="true">✦</span>
                  {t.recollection.serendipity}
                </h3>
                <motion.div className="recollection-cards" variants={cardContainerVariants} initial="hidden" animate="visible">
                  {renderCard(randomDate, (() => {
                    const p = parseYmd(randomDate)
                    const r = parseYmd(today)
                    if (!p || !r) return ''
                    const days = Math.round((new Date(r.y, r.m - 1, r.d).getTime() - new Date(p.y, p.m - 1, p.d).getTime()) / 86400000)
                    return days > 0 ? t.recollection.daysAgo(days) : ''
                  })())}
                </motion.div>
                {randomIdx < randomQueue.length - 1 && (
                  <button className="recollection-another" onClick={() => setRandomIdx(i => i + 1)}>
                    {t.recollection.another}
                  </button>
                )}
              </section>
            )}

            {similarDates.length > 0 && (
              <section className="recollection-section">
                <h3 className="recollection-section-heading">
                  <span className="recollection-section-glyph" aria-hidden="true">≈</span>
                  {t.recollection.similarDays}
                </h3>
                <motion.div className="recollection-cards" variants={cardContainerVariants} initial="hidden" animate="visible">
                  {similarDates.map(date => {
                    const p = parseYmd(date)
                    const r = parseYmd(today)
                    const eyebrow = p && r
                      ? (() => {
                          const days = Math.round((new Date(r.y, r.m - 1, r.d).getTime() - new Date(p.y, p.m - 1, p.d).getTime()) / 86400000)
                          if (days >= 365) return t.recollection.yearsAgo(Math.round(days / 365))
                          if (days >= 30) return t.recollection.monthsAgo(Math.round(days / 30))
                          return days > 0 ? t.recollection.daysAgo(days) : ''
                        })()
                      : ''
                    return renderCard(date, eyebrow)
                  })}
                </motion.div>
              </section>
            )}
          </div>
        )}
    </motion.dialog>
  )
}
