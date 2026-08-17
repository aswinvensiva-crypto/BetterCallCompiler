import { describe, expect, it } from 'vitest'
import {
  BUDGET_MS,
  describePass,
  explainOutcome,
  hotspotsOf,
  isMemoReuse,
  latencyOf,
  percentile,
  workOf
} from '../../src/shared/pass-analysis'
import type { CompilerPass, CompilerTraceEvent } from '../../src/shared/types'

function event(overrides: Partial<CompilerTraceEvent> = {}): CompilerTraceEvent {
  return {
    key: 'diag:src/a.ts',
    outcome: 'recomputed',
    durability: 'workspace',
    ms: 1,
    depth: 0,
    depsWalked: 0,
    ...overrides
  }
}

function pass(overrides: Partial<CompilerPass> = {}): CompilerPass {
  return {
    id: 1,
    reason: 'watch',
    requested: 1,
    recomputed: 1,
    reused: 0,
    totalMs: 10,
    events: [],
    stats: {
      revision: 1,
      memoCount: 1,
      hits: 0,
      misses: 1,
      recomputes: 1,
      cutoffs: 0,
      durableSkips: 0
    },
    ...overrides
  }
}

describe('percentile', () => {
  it('uses nearest-rank rather than interpolating', () => {
    // Interpolation would answer 25 for p50 here. That is a duration no pass
    // ever took, and this panel reports observations rather than estimates.
    expect(percentile([10, 20, 30, 40], 50)).toBe(20)
  })

  it('returns the maximum at p100 and the minimum at p1', () => {
    expect(percentile([5, 1, 9], 100)).toBe(9)
    expect(percentile([5, 1, 9], 1)).toBe(1)
  })

  it('does not mutate its input', () => {
    const values = [3, 1, 2]
    percentile(values, 50)
    expect(values).toEqual([3, 1, 2])
  })

  it('answers zero for no samples instead of NaN', () => {
    expect(percentile([], 95)).toBe(0)
  })
})

describe('latencyOf', () => {
  /**
   * The exclusion that makes the figure mean anything. A cold index takes
   * seconds by design; leaving it in the sample drags p95 so far up that the
   * interactive numbers being claimed become invisible.
   */
  it('excludes the cold index from typing latency', () => {
    const summary = latencyOf([
      pass({ reason: 'index', totalMs: 9000 }),
      pass({ reason: 'watch', totalMs: 20 }),
      pass({ reason: 'buffer', totalMs: 40 })
    ])

    expect(summary.count).toBe(2)
    expect(summary.worst).toBe(40)
    expect(summary.p50).toBe(20)
  })

  it('counts passes inside the 100ms budget', () => {
    const summary = latencyOf([
      pass({ totalMs: 10 }),
      pass({ totalMs: BUDGET_MS }),
      pass({ totalMs: BUDGET_MS + 1 })
    ])

    // The budget is inclusive: exactly 100ms met it.
    expect(summary.withinBudget).toBe(2)
  })

  it('handles a daemon that has only ever indexed', () => {
    const summary = latencyOf([pass({ reason: 'index', totalMs: 9000 })])
    expect(summary).toEqual({ count: 0, p50: 0, p95: 0, worst: 0, withinBudget: 0 })
  })
})

describe('workOf', () => {
  it('aggregates the headline pair across passes', () => {
    const summary = workOf([
      pass({ requested: 51, recomputed: 1, reused: 49 }),
      pass({ requested: 9, recomputed: 9, reused: 0 })
    ])

    expect(summary.requested).toBe(60)
    expect(summary.recomputed).toBe(10)
    expect(summary.reused).toBe(49)
    expect(summary.savedPercent).toBe(82)
  })

  it('reports zero saved rather than NaN when nothing was requested', () => {
    expect(workOf([]).savedPercent).toBe(0)
    expect(workOf([pass({ requested: 0, recomputed: 0, reused: 0 })]).savedPercent).toBe(0)
  })
})

describe('hotspotsOf', () => {
  /**
   * Ranked by total time, not by count. A file checked twice for 400ms is a
   * bigger problem than one checked forty times for 1ms, and ranking by count
   * surfaces the second while hiding the first.
   */
  it('ranks by total time rather than number of checks', () => {
    const hotspots = hotspotsOf([
      pass({
        events: [
          event({ key: 'diag:slow.ts', ms: 400 }),
          event({ key: 'diag:slow.ts', ms: 400 }),
          ...Array.from({ length: 40 }, () => event({ key: 'diag:chatty.ts', ms: 1 }))
        ]
      })
    ])

    expect(hotspots[0]?.path).toBe('slow.ts')
    expect(hotspots[0]?.totalMs).toBe(800)
    expect(hotspots[1]?.path).toBe('chatty.ts')
    expect(hotspots[1]?.checks).toBe(40)
  })

  /**
   * text: and sig: events describe the same files as diag:. Counting all three
   * would triple every number and mean nothing.
   */
  it('counts only the diagnostics query', () => {
    const hotspots = hotspotsOf([
      pass({
        events: [
          event({ key: 'diag:a.ts', ms: 5 }),
          event({ key: 'sig:a.ts', ms: 100 }),
          event({ key: 'text:a.ts', ms: 100 })
        ]
      })
    ])

    expect(hotspots).toHaveLength(1)
    expect(hotspots[0]?.totalMs).toBe(5)
  })

  it('separates checks from reuses', () => {
    const hotspots = hotspotsOf([
      pass({
        events: [
          event({ key: 'diag:a.ts', outcome: 'validated' }),
          event({ key: 'diag:a.ts', outcome: 'durable' }),
          event({ key: 'diag:a.ts', outcome: 'cutoff' })
        ]
      })
    ])

    // `cutoff` is a check: the type checker ran and the answer matched.
    expect(hotspots[0]).toMatchObject({ checks: 1, reuses: 2 })
  })

  it('honours the limit and breaks ties by path', () => {
    const hotspots = hotspotsOf(
      [
        pass({
          events: [
            event({ key: 'diag:b.ts', ms: 1 }),
            event({ key: 'diag:a.ts', ms: 1 }),
            event({ key: 'diag:c.ts', ms: 1 })
          ]
        })
      ],
      2
    )

    expect(hotspots.map((h) => h.path)).toEqual(['a.ts', 'b.ts'])
  })
})

describe('explainOutcome', () => {
  it('produces a sentence for every outcome', () => {
    for (const outcome of ['miss', 'fresh', 'durable', 'validated', 'cutoff', 'recomputed'] as const) {
      const sentence = explainOutcome(event({ outcome }))
      expect(sentence.length).toBeGreaterThan(10)
      expect(sentence.endsWith('.')).toBe(true)
    }
  })

  it('names the durability tier that did the skipping', () => {
    expect(explainOutcome(event({ outcome: 'durable', durability: 'lib' }))).toContain('lib')
  })
})

describe('describePass', () => {
  it('names the trigger and the two numbers that matter', () => {
    const line = describePass(pass({ reason: 'watch', requested: 51, recomputed: 1, reused: 49 }))
    expect(line).toContain('File changed on disk')
    expect(line).toContain('51 files')
    expect(line).toContain('1 type-checked')
    expect(line).toContain('49 reused')
  })

  it('singularises one file', () => {
    expect(describePass(pass({ requested: 1 }))).toContain('1 file in')
  })

  it('says so when there was nothing to do', () => {
    expect(describePass(pass({ requested: 0 }))).toContain('nothing to check')
  })
})

describe('isMemoReuse', () => {
  it('counts the three outcomes that skipped the work', () => {
    expect(isMemoReuse('fresh')).toBe(true)
    expect(isMemoReuse('durable')).toBe(true)
    expect(isMemoReuse('validated')).toBe(true)
  })

  it('does not count a cutoff, because the work did run', () => {
    // The one case that looks like reuse and is not. A cutoff means the checker
    // ran and the answer came out identical — filing it under reuse would
    // overstate the saving by exactly the file the user just edited.
    expect(isMemoReuse('cutoff')).toBe(false)
    expect(isMemoReuse('miss')).toBe(false)
    expect(isMemoReuse('recomputed')).toBe(false)
  })
})
