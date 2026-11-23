import { describe, it, expect, beforeEach } from 'vitest'
import { setActiveAccount } from '../../src/lib/accountSession'
import { clearSeen, loadSeen, recordSeen } from '../../src/utils/serendipitySeen'

const KEY = 'linger_serendipity_seen'

describe('serendipitySeen', () => {
  beforeEach(() => {
    setActiveAccount(null)
    clearSeen()
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

  it('discards old plaintext history and keeps new history in memory', () => {
    localStorage.setItem(KEY, JSON.stringify([{ date: '2020-01-01', ts: 1 }]))
    clearSeen()
    recordSeen('2020-02-02', 2)
    expect(loadSeen()).toEqual([{ date: '2020-02-02', ts: 2 }])
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('clears history when signing out or switching accounts', () => {
    setActiveAccount('sub:account-a')
    recordSeen('2020-01-01', 1)
    setActiveAccount('sub:account-a')
    expect(loadSeen()).toHaveLength(1)
    setActiveAccount('sub:account-b')
    expect(loadSeen()).toEqual([])
    recordSeen('2020-02-02', 2)
    localStorage.setItem(KEY, JSON.stringify([{ date: '2020-01-01', ts: 1 }]))
    setActiveAccount(null, true)
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(loadSeen()).toEqual([])
  })
})
