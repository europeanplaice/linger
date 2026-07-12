import { describe, it, expect } from 'vitest'
import { extractCandidateWords, findRecurringAbsentTopic } from '../../src/utils/topicExtraction'

describe('extractCandidateWords', () => {
  it('extracts kanji/katakana runs for Japanese', () => {
    const words = extractCandidateWords('友達と東京タワーに行った', 'ja')
    expect(words).toContain('友達')
    expect(words).toContain('東京タワー')
  })

  it('excludes common Japanese stopwords', () => {
    const words = extractCandidateWords('今日は自分のことを考えた', 'ja')
    expect(words).not.toContain('今日')
    expect(words).not.toContain('自分')
  })

  it('extracts word tokens for English', () => {
    const words = extractCandidateWords('I went hiking with my sister today', 'en')
    expect(words).toContain('hiking')
    expect(words).toContain('sister')
  })

  it('excludes common English stopwords', () => {
    const words = extractCandidateWords('I really think about this thing today', 'en')
    expect(words).not.toContain('really')
    expect(words).not.toContain('think')
    expect(words).not.toContain('today')
  })
})

describe('findRecurringAbsentTopic', () => {
  it('finds a word written about steadily across months but absent recently', () => {
    const contents = new Map([
      ['2026-02-01', '仕事で疲れた一日だった'],
      ['2026-03-05', '今日も仕事が忙しかった'],
      ['2026-04-10', '仕事の後に友達と会った'],
      ['2026-05-01', '仕事のことばかり考えていた'],
      ['2026-06-01', '友達とご飯を食べた'],
      ['2026-06-05', '天気がよかった'],
    ])
    const result = findRecurringAbsentTopic(contents, '2026-06-12', 14, 'ja')
    expect(result?.term).toBe('仕事')
    expect(result?.count).toBe(4)
  })

  it('excludes a word that also appears within the recent window', () => {
    const contents = new Map([
      ['2026-02-01', '仕事で疲れた一日だった'],
      ['2026-03-05', '今日も仕事が忙しかった'],
      ['2026-04-10', '仕事の後に友達と会った'],
      ['2026-05-01', '仕事のことばかり考えていた'],
      ['2026-06-10', '仕事が終わって一息ついた'],
    ])
    const result = findRecurringAbsentTopic(contents, '2026-06-12', 14, 'ja')
    expect(result).toBeNull()
  })

  it('ignores a one-off mention (needs several past occurrences)', () => {
    const contents = new Map([
      ['2026-05-01', '旅行に行った'],
    ])
    const result = findRecurringAbsentTopic(contents, '2026-06-12', 14, 'ja')
    expect(result).toBeNull()
  })

  it('does not surface a concentrated burst that then stopped (e.g. a dropped topic)', () => {
    // Same month, several mentions, never mentioned again — this is the
    // signature of a topic someone deliberately stopped writing about
    // (a breakup, a loss), and should not be cheerfully resurfaced.
    const contents = new Map([
      ['2026-04-02', 'アリスと話した'],
      ['2026-04-05', 'アリスのことを考えた'],
      ['2026-04-10', 'アリスと会った'],
      ['2026-04-15', 'アリスと出かけた'],
    ])
    const result = findRecurringAbsentTopic(contents, '2026-06-12', 14, 'ja')
    expect(result).toBeNull()
  })

  it('ignores today and future-dated content', () => {
    const contents = new Map([
      ['2026-06-12', '仕事の話を書いた仕事の話'],
      ['2026-07-01', '仕事のことを書いた'],
    ])
    const result = findRecurringAbsentTopic(contents, '2026-06-12', 14, 'ja')
    expect(result).toBeNull()
  })

  it('returns null when there is nothing to surface', () => {
    expect(findRecurringAbsentTopic(new Map(), '2026-06-12', 14, 'ja')).toBeNull()
  })
})
