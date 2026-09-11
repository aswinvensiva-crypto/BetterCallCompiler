import { describe, expect, it } from 'vitest'
import {
  BUDGET_MS,
  chartScaleOf,
  describePass,
  describeWhy,
  explainOutcome,
  hotspotsOf,
  isInteractive,
  isMemoReuse,
  latencyOf,
  percentile,
  whyChecked,
  workOf,
  type WhyRecord
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
        trigger: [],
id: 1,
    language: 'typescript',
    at: 0,
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

describe('cold passes', () => {
  it('keeps the first check of a workspace out of typing latency', () => {
    const summary = latencyOf([
      pass({ totalMs: 20 }),
      pass({ totalMs: 40 }),
      pass({ reason: 'cold', totalMs: 4000 })
    ])

    // A four-second program build is not a keystroke. Left in the sample it
    // drags p95 so far that the interactive numbers become invisible.
    expect(summary.count).toBe(2)
    expect(summary.worst).toBe(40)
  })

  it('names the first check in the history line', () => {
    expect(describePass(pass({ reason: 'cold', requested: 3 }))).toContain(
      'First check of this workspace'
    )
  })

  it('still distinguishes the walk from the first check', () => {
    expect(describePass(pass({ reason: 'index', requested: 3 }))).toContain('Workspace indexed')
    expect(isInteractive(pass({ reason: 'index' }))).toBe(false)
    expect(isInteractive(pass({ reason: 'cold' }))).toBe(false)
    expect(isInteractive(pass({ reason: 'watch' }))).toBe(true)
    expect(isInteractive(pass({ reason: 'buffer' }))).toBe(true)
  })
})

describe('chartScaleOf', () => {
  it('floors at 1.5x the budget when every pass is fast', () => {
    const scale = chartScaleOf([pass({ totalMs: 5 }), pass({ totalMs: 12 })])

    // Without the floor, a fast session gets a hair-trigger scale on which every
    // ordinary pass draws as alarmingly tall.
    expect(scale.ceilingMs).toBe(BUDGET_MS * 1.5)
    expect(scale.budgetFraction).toBeCloseTo(1 / 1.5)
  })

  it('follows p95 once passes are genuinely slow', () => {
    const slow = Array.from({ length: 20 }, (_, i) => pass({ totalMs: 200 + i * 20 }))
    const scale = chartScaleOf(slow)

    expect(scale.ceilingMs).toBeGreaterThan(BUDGET_MS * 1.5)
    expect(scale.budgetFraction).toBeLessThan(1)
  })

  it('ignores cold and index passes when picking the ceiling', () => {
    // The bug this whole step exists for: a four-second program build setting the
    // scale squashes every interactive pass to nothing.
    const scale = chartScaleOf([
      pass({ totalMs: 8 }),
      pass({ reason: 'cold', totalMs: 4000 }),
      pass({ reason: 'index', totalMs: 3000 })
    ])

    expect(scale.ceilingMs).toBe(BUDGET_MS * 1.5)
  })

  it('always returns a drawable budget fraction', () => {
    for (const passes of [[], [pass({ totalMs: 1 })], [pass({ totalMs: 9999 })]]) {
      const { budgetFraction } = chartScaleOf(passes)
      expect(budgetFraction).toBeGreaterThan(0)
      expect(budgetFraction).toBeLessThanOrEqual(1)
    }
  })
})

describe('describePass with a trigger', () => {
  it('names the file when exactly one changed', () => {
    const line = describePass(pass({ trigger: ['src/lib.ts'], requested: 4, recomputed: 1 }))

    // The whole point: the History tab could not previously say WHICH file the
    // user touched, only that something on disk changed.
    expect(line).toContain('File changed on disk (src/lib.ts)')
    expect(line).toContain('4 files in the invalidation set')
  })

  it('falls back to the plain sentence for a coalesced batch', () => {
    const line = describePass(pass({ trigger: ['a.ts', 'b.ts'], requested: 9 }))

    expect(line).toContain('File changed on disk —')
    expect(line).not.toContain('(a.ts)')
  })

  it('falls back to the plain sentence when nothing is named', () => {
    expect(describePass(pass({ trigger: [], requested: 0 }))).toBe(
      'File changed on disk — nothing to check'
    )
  })

  it('names the file for an unsaved buffer too', () => {
    expect(describePass(pass({ reason: 'buffer', trigger: ['src/app.ts'], requested: 1 }))).toContain(
      'Unsaved buffer (src/app.ts)'
    )
  })
})

describe('whyChecked', () => {
  const diagEvent = (path: string, overrides: Partial<CompilerTraceEvent> = {}) => ({
    key: `diag:${path}`,
    outcome: 'validated' as const,
    durability: 'workspace' as const,
    ms: 3,
    depth: 0,
    depsWalked: 2,
    ...overrides
  })

  it('reports the most recent pass that named the file', () => {
    const record = whyChecked(
      [
        pass({ id: 1, trigger: ['src/old.ts'], events: [diagEvent('src/app.ts')] }),
        pass({ id: 2, trigger: ['src/lib.ts'], events: [diagEvent('src/app.ts')] })
      ],
      'src/app.ts'
    )

    // Newest-first: pass 2 is the state the user is looking at.
    expect(record?.passId).toBe(2)
    expect(record?.trigger).toEqual(['src/lib.ts'])
  })

  it('returns null for a file no retained pass mentions', () => {
    expect(whyChecked([pass({ events: [diagEvent('src/app.ts')] })], 'src/other.ts')).toBeNull()
  })

  it('ignores a sig: event for the same path', () => {
    const sigOnly = pass({
      events: [{ ...diagEvent('src/app.ts'), key: 'sig:src/app.ts' }]
    })

    // The diag event is the answer; sig is supporting detail.
    expect(whyChecked([sigOnly], 'src/app.ts')).toBeNull()
  })

  it('does not answer for a path that is merely a prefix of another', () => {
    const record = whyChecked([pass({ events: [diagEvent('src/a.tsx')] })], 'src/a.ts')

    // A prefix test would have matched here and reported the wrong file.
    expect(record).toBeNull()
  })

  it('carries the outcome and the pass totals through', () => {
    const record = whyChecked(
      [
        pass({
          requested: 12,
          recomputed: 1,
          events: [diagEvent('src/app.ts', { outcome: 'cutoff', ms: 41, depsWalked: 7 })]
        })
      ],
      'src/app.ts'
    )

    expect(record?.outcome).toBe('cutoff')
    expect(record?.ms).toBe(41)
    expect(record?.depsWalked).toBe(7)
    expect(record?.requested).toBe(12)
    expect(record?.recomputed).toBe(1)
  })
})

describe('describeWhy', () => {
  const record = (overrides: Partial<WhyRecord> = {}): WhyRecord => ({
    passId: 1,
    reason: 'watch',
    trigger: ['src/lib.ts'],
    outcome: 'recomputed',
    durability: 'workspace',
    ms: 12,
    depsWalked: 3,
    requested: 2,
    recomputed: 2,
    ...overrides
  })

  it('names the file that changed', () => {
    expect(describeWhy(record())).toBe('Because src/lib.ts changed.')
  })

  it('still names the file on a cold pass', () => {
    const sentence = describeWhy(record({ reason: 'cold' }))

    // The regression this test exists for. Coldness is ADDITIVE context, not a
    // replacement for the answer — and the cold pass is the first thing anyone
    // clicks in a fresh session, so dropping the filename there is the worst
    // place to drop it.
    expect(sentence).toContain('src/lib.ts')
    expect(sentence).toContain('first check of the workspace')
  })

  it('summarises a coalesced batch rather than naming one of many', () => {
    expect(describeWhy(record({ trigger: ['a.ts', 'b.ts', 'c.ts'] }))).toBe(
      'Because 3 files changed, including a.ts.'
    )
  })

  it('says so when the pass named nothing', () => {
    expect(describeWhy(record({ trigger: [] }))).toBe(
      'Rechecked by a pass that named no specific file.'
    )
  })
})
