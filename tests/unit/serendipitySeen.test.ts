import { describe, it, expect, beforeEach } from 'vitest'
import { loadSeen, recordSeen } from '../../src/utils/serendipitySeen'

const KEY = 'linger_serendipity_seen'

describe('serendipitySeen', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns an empty array when nothing is stored', () => {
    expect(loadSeen()).toEqual([])
  })

  it('records a shown date, newest first', () => {
    recordSeen('2020-01-01', 1000)
    recordSeen('2020-02-02', 2000)
    const seen = loadSeen()
    expect(seen.map(s => s.date)).toEqual(['2020-02-02', '2020-01-01'])
    expect(seen[0].ts).toBe(2000)
  })

  it('dedupes: re-recording a date moves it to the front with a fresh timestamp', () => {
    recordSeen('2020-01-01', 1000)
    recordSeen('2020-02-02', 2000)
    recordSeen('2020-01-01', 3000)
    const seen = loadSeen()
    expect(seen.map(s => s.date)).toEqual(['2020-01-01', '2020-02-02'])
    expect(seen[0].ts).toBe(3000)
  })

  it('caps stored history at 30 entries', () => {
    for (let i = 0; i < 40; i++) recordSeen(`${2000 + i}-06-15`, i)
    expect(loadSeen().length).toBe(30)
  })

  it('recovers gracefully from corrupt JSON', () => {
    localStorage.setItem(KEY, '{not json')
    expect(loadSeen()).toEqual([])
  })

  it('ignores non-array stored values', () => {
    localStorage.setItem(KEY, '"a string"')
    expect(loadSeen()).toEqual([])
  })

  it('filters out malformed entries', () => {
    localStorage.setItem(KEY, JSON.stringify([{ date: 'x', ts: 1 }, { date: 5 }, null, { ts: 2 }]))
    expect(loadSeen()).toEqual([{ date: 'x', ts: 1 }])
  })
})
