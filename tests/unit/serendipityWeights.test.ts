import { describe, it, expect } from 'vitest'
import { serendipityWeight, weightedOrder } from '../../src/utils/serendipityWeights'
import type { SeenEntry } from '../../src/utils/serendipitySeen'

const TODAY = '2026-05-22'
const DAY = 86_400_000

describe('serendipityWeight', () => {
  it('weights older entries higher than recent ones', () => {
    const old = serendipityWeight('2016-05-22', { today: TODAY })
    const recent = serendipityWeight('2026-04-22', { today: TODAY })
    expect(old).toBeGreaterThan(recent)
  })

  it('penalises a just-shown date, recovering over time', () => {
    const now = Date.UTC(2026, 4, 22)
    const date = '2020-01-15'
    const base = serendipityWeight(date, { today: TODAY, now })
    const justShown: SeenEntry[] = [{ date, ts: now }]
    const recovered: SeenEntry[] = [{ date, ts: now - 14 * DAY }]

    const penalised = serendipityWeight(date, { today: TODAY, recentlyShown: justShown, now })
    const healed = serendipityWeight(date, { today: TODAY, recentlyShown: recovered, now })

    expect(penalised).toBeLessThan(base)
    expect(penalised).toBeCloseTo(base * 0.1, 5)
    expect(healed).toBeCloseTo(base, 5)
  })

  it('mildly boosts entries in the same season as today', () => {
    // Same calendar day a few years back vs. opposite side of the year.
    const sameSeason = serendipityWeight('2022-05-25', { today: TODAY })
    const offSeason = serendipityWeight('2022-11-22', { today: TODAY })
    // Both are equally old (within days), so the season boost dominates.
    expect(sameSeason).toBeGreaterThan(offSeason)
  })

  it('nudges down dates known to be empty', () => {
    const date = '2020-01-15'
    const full = serendipityWeight(date, { today: TODAY })
    const empty = serendipityWeight(date, { today: TODAY, emptyDates: new Set([date]) })
    expect(empty).toBeLessThan(full)
  })

  it('always returns a positive weight', () => {
    const w = serendipityWeight(TODAY, { today: TODAY })
    expect(w).toBeGreaterThan(0)
  })
})

describe('weightedOrder', () => {
  const candidates = ['2024-01-01', '2022-06-06', '2020-03-03', '2018-09-09']

  it('returns a full permutation with no dropped or duplicated entries', () => {
    const out = weightedOrder(candidates, { today: TODAY, rng: () => 0.5 })
    expect(out.slice().sort()).toEqual(candidates.slice().sort())
  })

  it('is deterministic for a fixed rng', () => {
    const seq = [0.1, 0.9, 0.3, 0.7]
    let i = 0
    const rng = () => seq[i++ % seq.length]
    const a = weightedOrder(candidates, { today: TODAY, rng })
    i = 0
    const b = weightedOrder(candidates, { today: TODAY, rng })
    expect(a).toEqual(b)
  })

  it('sinks a recently-shown date toward the back', () => {
    const now = Date.UTC(2026, 4, 22)
    const shown = '2024-01-01'
    // Constant rng → ordering decided purely by weights (key = -ln(u)/w).
    const out = weightedOrder(candidates, {
      today: TODAY,
      recentlyShown: [{ date: shown, ts: now }],
      now,
      rng: () => 0.5,
    })
    expect(out[out.length - 1]).toBe(shown)
  })

  it('places older entries earlier with constant rng', () => {
    const out = weightedOrder(candidates, { today: TODAY, rng: () => 0.5 })
    // Oldest candidate should come first when randomness is held constant.
    expect(out[0]).toBe('2018-09-09')
  })

  it('nudges empty-content dates toward the back', () => {
    const out = weightedOrder(candidates, {
      today: TODAY,
      emptyDates: new Set(['2018-09-09']),
      rng: () => 0.5,
    })
    expect(out[out.length - 1]).toBe('2018-09-09')
  })

  it('handles rng returning 0 without producing Infinity keys', () => {
    const out = weightedOrder(candidates, { today: TODAY, rng: () => 0 })
    expect(out.slice().sort()).toEqual(candidates.slice().sort())
  })

  it('handles an empty candidate list', () => {
    expect(weightedOrder([], { today: TODAY })).toEqual([])
  })
})
