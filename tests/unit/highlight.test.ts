import { describe, it, expect } from 'vitest'
import { highlightText, type TextSegment } from '../../src/utils/highlight'

function highlighted(segments: TextSegment[]): string[] {
  return segments
    .filter((s): s is { text: string; highlight: true } => typeof s === 'object')
    .map(s => s.text)
}

function plain(segments: TextSegment[]): string {
  return segments.map(s => typeof s === 'string' ? s : s.text).join('')
}

describe('highlightText', () => {
  it('returns a single string segment when there are no tokens', () => {
    const result = highlightText('今日は良い日でした', [])
    expect(result).toEqual(['今日は良い日でした'])
  })

  it('returns a single string segment when no token matches', () => {
    const result = highlightText('今日は良い日でした', ['xyz'])
    expect(result).toEqual(['今日は良い日でした'])
  })

  it('preserves the full original text across segments', () => {
    const text = '仕事が大変だった'
    const result = highlightText(text, ['仕事'])
    expect(plain(result)).toBe(text)
  })

  it('highlights a single bigram match', () => {
    const result = highlightText('仕事が大変だった', ['仕事'])
    expect(highlighted(result)).toContain('仕事')
  })

  it('highlights an English word token', () => {
    const result = highlightText('Today was a great day', ['today'])
    expect(highlighted(result)).toContain('Today')
  })

  it('merges adjacent overlapping bigrams into one span', () => {
    // '今日は' contains bigrams '今日'(0-2) and '日は'(1-3) — should merge to '今日は'
    const result = highlightText('今日は良い日', ['今日', '日は'])
    const spans = highlighted(result)
    // merged span should cover '今日は', not two separate '今日' and '日は'
    expect(spans).toContain('今日は')
    expect(spans).not.toContain('今日')
    expect(spans).not.toContain('日は')
  })

  it('handles multiple non-overlapping tokens', () => {
    const result = highlightText('仕事と疲れの話', ['仕事', '疲れ'])
    const spans = highlighted(result)
    expect(spans).toContain('仕事')
    expect(spans).toContain('疲れ')
  })

  it('is case-insensitive for Latin tokens', () => {
    const result = highlightText('Hello World', ['hello'])
    expect(highlighted(result)).toContain('Hello')
  })

  it('handles empty text', () => {
    expect(highlightText('', ['仕事'])).toEqual([''])
  })

  it('handles token at the very start of text', () => {
    const result = highlightText('仕事が大変', ['仕事'])
    expect(result[0]).toEqual({ text: '仕事', highlight: true })
  })

  it('handles token at the very end of text', () => {
    const result = highlightText('とても大変', ['大変'])
    const last = result[result.length - 1]
    expect(last).toEqual({ text: '大変', highlight: true })
  })

  it('produces no empty string segments', () => {
    const result = highlightText('仕事', ['仕事'])
    const emptyStrings = result.filter(s => typeof s === 'string' && s === '')
    expect(emptyStrings).toHaveLength(0)
  })
})
