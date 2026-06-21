import { describe, it, expect } from 'vitest'
import { tokenize, buildIndex, search, findSimilar } from '../../src/utils/tfidf'

describe('tokenize', () => {
  it('extracts word tokens from English text', () => {
    const tokens = tokenize('Hello world test')
    expect(tokens).toContain('hello')
    expect(tokens).toContain('world')
    expect(tokens).toContain('test')
  })

  it('extracts character bigrams', () => {
    const tokens = tokenize('abc')
    expect(tokens).toContain('ab')
    expect(tokens).toContain('bc')
  })

  it('extracts bigrams from Japanese text', () => {
    const tokens = tokenize('疲れた')
    expect(tokens).toContain('疲れ')
    expect(tokens).toContain('れた')
  })

  it('allows 疲れ query to match 疲れた and 疲れが', () => {
    const docTokens1 = tokenize('疲れた')
    const docTokens2 = tokenize('疲れが続く')
    const queryTokens = tokenize('疲れ')
    for (const qt of queryTokens) {
      expect(docTokens1).toContain(qt)
      expect(docTokens2).toContain(qt)
    }
  })

  it('does not create bigrams spanning whitespace', () => {
    const tokens = tokenize('a b')
    expect(tokens).not.toContain('a ')
    expect(tokens).not.toContain(' b')
  })

  it('normalizes to lowercase', () => {
    const tokens = tokenize('Hello World')
    expect(tokens).toContain('hello')
    expect(tokens).not.toContain('Hello')
  })

  it('returns empty array for empty string', () => {
    expect(tokenize('')).toEqual([])
  })

  it('handles mixed Japanese and English text', () => {
    const tokens = tokenize('Today was 楽しい日')
    expect(tokens).toContain('today')
    expect(tokens).toContain('楽し')
    expect(tokens).toContain('しい')
  })

  it('applies NFKC normalization (full-width to half-width)', () => {
    const tokens = tokenize('ａｂｃ')
    expect(tokens).toContain('ab')
    expect(tokens).toContain('bc')
  })
})

describe('buildIndex', () => {
  it('returns empty index for empty docs', () => {
    const idx = buildIndex([])
    expect(idx.vectors.size).toBe(0)
    expect(idx.contents.size).toBe(0)
  })

  it('creates one vector per document', () => {
    const idx = buildIndex([
      { date: '2024-01-01', content: 'hello world' },
      { date: '2024-01-02', content: 'hello there' },
    ])
    expect(idx.vectors.size).toBe(2)
    expect(idx.vectors.has('2024-01-01')).toBe(true)
    expect(idx.vectors.has('2024-01-02')).toBe(true)
  })

  it('stores original content for snippet extraction', () => {
    const idx = buildIndex([{ date: '2024-01-01', content: 'hello world' }])
    expect(idx.contents.get('2024-01-01')).toBe('hello world')
  })

  it('produces L2-normalized vectors (norm ≈ 1)', () => {
    const idx = buildIndex([{ date: '2024-01-01', content: 'hello world test entry' }])
    const vec = idx.vectors.get('2024-01-01')!
    let normSq = 0
    vec.forEach(v => { normSq += v * v })
    expect(Math.sqrt(normSq)).toBeCloseTo(1, 5)
  })

  it('handles a single document without errors', () => {
    const idx = buildIndex([{ date: '2024-01-01', content: '今日は良い日だった' }])
    expect(idx.vectors.size).toBe(1)
  })
})

describe('search', () => {
  const docs = [
    { date: '2024-01-01', content: '今日はとても疲れた。仕事が大変だった。' },
    { date: '2024-01-02', content: '楽しい一日だった。友達と会った。' },
    { date: '2024-01-03', content: '疲れが続いている。休みたい。' },
  ]

  it('finds entries matching a Japanese keyword', () => {
    const idx = buildIndex(docs)
    const results = search(idx, '疲れ')
    const dates = results.map(r => r.date)
    expect(dates).toContain('2024-01-01')
    expect(dates).toContain('2024-01-03')
    expect(dates).not.toContain('2024-01-02')
  })

  it('returns results sorted by score descending', () => {
    const idx = buildIndex(docs)
    const results = search(idx, '疲れ')
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score)
    }
  })

  it('returns empty array when no entries match', () => {
    const idx = buildIndex(docs)
    expect(search(idx, 'xyznotfound')).toEqual([])
  })

  it('includes a non-empty snippet in each result', () => {
    const idx = buildIndex(docs)
    const results = search(idx, '疲れ')
    for (const r of results) {
      expect(r.snippet.length).toBeGreaterThan(0)
    }
  })

  it('finds English entries by keyword and ranks exact word match highest', () => {
    const enDocs = [
      { date: '2024-01-01', content: 'Today was a great day at work.' },
      { date: '2024-01-02', content: 'Tired and exhausted from the project.' },
    ]
    const idx = buildIndex(enDocs)
    const results = search(idx, 'tired')
    // The entry containing "tired" as a word token must rank first
    expect(results[0].date).toBe('2024-01-02')
  })

  it('respects the limit parameter', () => {
    const manyDocs = Array.from({ length: 20 }, (_, i) => ({
      date: `2024-01-${String(i + 1).padStart(2, '0')}`,
      content: `test entry about work number ${i}`,
    }))
    const idx = buildIndex(manyDocs)
    expect(search(idx, 'test', 5).length).toBeLessThanOrEqual(5)
  })

  it('returns empty for empty index', () => {
    const idx = buildIndex([])
    expect(search(idx, 'test')).toEqual([])
  })

  it('returns empty for empty query', () => {
    const idx = buildIndex(docs)
    expect(search(idx, '')).toEqual([])
  })
})

describe('findSimilar', () => {
  const docs = [
    { date: '2024-01-01', content: '仕事がつらくて疲れた。残業が多い。夜遅い帰宅。' },
    { date: '2024-01-02', content: '疲れがひどい。仕事を休みたい。残業続き。' },
    { date: '2024-01-03', content: '楽しい休日。友達と映画を見た。リラックスできた。' },
    { date: '2024-01-04', content: '映画が面白かった。また行きたい。友達と話した。' },
  ]

  it('returns similar entries for a known date', () => {
    const idx = buildIndex(docs)
    const similar = findSimilar(idx, '2024-01-01', 3)
    expect(similar.length).toBeGreaterThan(0)
  })

  it('does not include the queried date itself', () => {
    const idx = buildIndex(docs)
    const similar = findSimilar(idx, '2024-01-01', 5)
    expect(similar).not.toContain('2024-01-01')
  })

  it('ranks thematically similar content higher (work/tired before movies/friends)', () => {
    const idx = buildIndex(docs)
    const similar = findSimilar(idx, '2024-01-01', 3)
    const idxOf02 = similar.indexOf('2024-01-02')
    const idxOf03 = similar.indexOf('2024-01-03')
    if (idxOf02 !== -1 && idxOf03 !== -1) {
      expect(idxOf02).toBeLessThan(idxOf03)
    } else {
      expect(idxOf02).not.toBe(-1)
    }
  })

  it('returns empty array for an unknown date', () => {
    const idx = buildIndex(docs)
    expect(findSimilar(idx, 'unknown-date', 5)).toEqual([])
  })

  it('returns empty for an index with a single document', () => {
    const idx = buildIndex([docs[0]])
    expect(findSimilar(idx, '2024-01-01', 5)).toEqual([])
  })

  it('returns empty for an empty index', () => {
    const idx = buildIndex([])
    expect(findSimilar(idx, '2024-01-01', 5)).toEqual([])
  })

  it('respects the limit parameter', () => {
    const idx = buildIndex(docs)
    const similar = findSimilar(idx, '2024-01-01', 2)
    expect(similar.length).toBeLessThanOrEqual(2)
  })
})
