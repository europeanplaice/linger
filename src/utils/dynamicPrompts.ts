import type { Language } from '../i18n'
import type { Milestone } from '../types'
import type { HolidayInfo } from './holidays'
import { extractCandidateWords, type RecurringTopic } from './topicExtraction'
import { dynamicPromptTemplates } from '../data/writingPrompts'
import { daysSinceLastEntry, consecutiveDayStreak, weekdayCategory, seasonKey, nearestMilestoneOccurrence } from './date'

// How far (in days, either direction) a milestone can be and still be worth
// mentioning as "coming up" / "just happened".
const MILESTONE_WINDOW_DAYS = 10

export interface DynamicPromptContext {
  date: string
  knownDates: string[]
  milestones: ReadonlyArray<Milestone>
  holiday?: HolidayInfo
  recurringTopic?: RecurringTopic | null
  // The entry's own text so far, when it's not empty. Lets the pool nudge
  // toward elaborating on something the user just wrote rather than only
  // generic "add-on" questions — omit for an empty entry, where there's
  // nothing yet to reference.
  currentText?: string
  language: Language
}

// Longest content word actually present in what's been written so far — a
// cheap proxy for "the most concrete/specific thing they just mentioned"
// without real NLP, reusing the same word-run heuristic as recurring-topic
// detection (see topicExtraction.ts).
function mostSpecificWord(text: string, language: Language): string | null {
  const words = extractCandidateWords(text, language)
  let best: string | null = null
  for (const w of words) {
    if (!best || w.length > best.length) best = w
  }
  return best
}

/**
 * Builds a pool of contextual writing prompts from cheap per-user signals —
 * milestones, entry cadence, weekday/season, holidays, the user's own
 * recurring-but-lately-untouched topics, and (once the entry has content) a
 * word pulled from what's already been written — rather than a single fixed
 * list. Each signal is independently gated by its own condition, so the
 * result only contains prompts that are actually applicable right now;
 * callers blend this with the static prompt bank to keep the pool from ever
 * being empty.
 */
export function buildDynamicPrompts(ctx: DynamicPromptContext): string[] {
  const T = dynamicPromptTemplates[ctx.language] ?? dynamicPromptTemplates.en
  const prompts: string[] = []

  const milestone = nearestMilestoneOccurrence(
    ctx.date,
    ctx.milestones.filter(m => m.showBadge !== false),
    MILESTONE_WINDOW_DAYS,
  )
  if (milestone) {
    if (milestone.distance === 0) prompts.push(T.milestoneToday(milestone.label))
    else if (milestone.distance > 0) prompts.push(T.milestoneUpcoming(milestone.label, milestone.distance))
    else prompts.push(T.milestoneRecent(milestone.label, Math.abs(milestone.distance)))
  }

  const gap = daysSinceLastEntry(ctx.knownDates, ctx.date)
  if (gap !== null) {
    if (gap >= 30) prompts.push(T.gapLong(gap))
    else if (gap >= 7) prompts.push(T.gapMedium(gap))
    else if (gap >= 3) prompts.push(T.gapShort(gap))
  }

  const streak = consecutiveDayStreak(ctx.knownDates, ctx.date)
  if (streak >= 3) prompts.push(T.streak(streak))

  const wd = weekdayCategory(ctx.date)
  if (wd === 'monday') prompts.push(T.weekdayMonday())
  else if (wd === 'friday') prompts.push(T.weekdayFriday())
  else if (wd === 'weekend') prompts.push(T.weekend())

  prompts.push(T.season(seasonKey(ctx.date)))

  if (ctx.holiday) prompts.push(T.holiday(ctx.holiday.localName || ctx.holiday.name))

  if (ctx.recurringTopic) prompts.push(T.recurringTopic(ctx.recurringTopic.term))

  if (ctx.currentText) {
    const term = mostSpecificWord(ctx.currentText, ctx.language)
    if (term) prompts.push(T.mentionedTopic(term))
  }

  return prompts
}
