import type { Language } from '../i18n'
import { shiftDate } from './date'

// Kanji/katakana runs read as reasonably clean Japanese noun phrases without a
// real tokenizer — most content words in a diary are 2-12 character compounds
// (long enough to cover multi-kanji compounds and longer katakana loanwords
// like オーストラリア or プレゼンテーション without truncating them mid-word),
// while grammar (particles, verb endings) is hiragana and falls outside the run.
const JA_WORD_RUN = /[一-鿿゠-ヿ]{2,12}/g
const EN_WORD = /[a-z]{4,}/g

// Words too generic to ever be a useful "you used to write about X" prompt,
// even though they recur constantly across entries.
const STOPWORDS_JA = new Set([
  '今日', '明日', '昨日', '今夜', '自分', '今回', '今週', '今月', '今年',
  '毎日', '最近', '今', '私', '思う', '感じ', '少し', '本当', '一日',
])
const STOPWORDS_EN = new Set([
  'today', 'yesterday', 'tomorrow', 'really', 'think', 'thing', 'things',
  'feel', 'feeling', 'felt', 'been', 'were', 'have', 'that', 'this', 'with',
  'from', 'they', 'just', 'like', 'about', 'when', 'what', 'more', 'some',
])

export function extractCandidateWords(content: string, language: Language): string[] {
  const normalized = content.normalize('NFKC')
  const words: string[] = []
  if (language === 'ja') {
    for (const m of normalized.match(JA_WORD_RUN) ?? []) {
      if (!STOPWORDS_JA.has(m)) words.push(m)
    }
  } else {
    for (const m of normalized.toLowerCase().match(EN_WORD) ?? []) {
      if (!STOPWORDS_EN.has(m)) words.push(m)
    }
  }
  return words
}

export interface RecurringTopic {
  term: string
  count: number
  lastSeenDate: string
}

// A word must show up at least this many times, spread across at least this
// many distinct calendar months, before it's surfaced as a "topic". This is
// what distinguishes a steady, ongoing interest (a hobby, a project) from a
// short, concentrated burst that then stopped — the latter is often the
// signature of a topic the user deliberately dropped (a breakup, a loss), and
// resurfacing it as a cheerful "what's the latest?" prompt would be the wrong
// call. Requiring months, not just count, keeps a single heavy week from
// qualifying on its own.
const MIN_OCCURRENCES = 4
const MIN_DISTINCT_MONTHS = 3

/**
 * Finds a word the user wrote about steadily in the past, but hasn't
 * mentioned in the last `windowDays` before `currentDate`. Words that also
 * appear in the recent window are excluded — this is what keeps
 * universally-common words out without an exhaustive stopword list, since a
 * truly generic word will show up recently too.
 */
export function findRecurringAbsentTopic(
  contents: Map<string, string>,
  currentDate: string,
  windowDays: number,
  language: Language,
): RecurringTopic | null {
  const cutoff = shiftDate(currentDate, -windowDays)

  const pastDocFreq = new Map<string, { count: number; lastSeen: string; months: Set<string> }>()
  const recentWords = new Set<string>()

  contents.forEach((content, date) => {
    if (date >= currentDate || !content) return
    const words = new Set(extractCandidateWords(content, language))
    if (date >= cutoff) {
      words.forEach(w => recentWords.add(w))
    } else {
      const month = date.slice(0, 7)
      words.forEach(w => {
        const entry = pastDocFreq.get(w)
        if (entry) {
          entry.count += 1
          entry.months.add(month)
          if (date > entry.lastSeen) entry.lastSeen = date
        } else {
          pastDocFreq.set(w, { count: 1, lastSeen: date, months: new Set([month]) })
        }
      })
    }
  })

  let best: RecurringTopic | null = null
  pastDocFreq.forEach(({ count, lastSeen, months }, term) => {
    if (recentWords.has(term) || count < MIN_OCCURRENCES || months.size < MIN_DISTINCT_MONTHS) return
    if (!best || count > best.count || (count === best.count && lastSeen > best.lastSeenDate)) {
      best = { term, count, lastSeenDate: lastSeen }
    }
  })
  return best
}
