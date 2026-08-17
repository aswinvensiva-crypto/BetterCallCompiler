import { describe, expect, it } from 'vitest'
import {
  createLedger,
  departed,
  nextDrain,
  noteAbandoned,
  noteChecked,
  noteDeferred,
  planPass,
  SMALL_PASS_FILES,
  type CheckLedger
} from '../../src/shared/check-ledger'

/** `n` distinct paths, so a pass can be pushed past SMALL_PASS_FILES. */
const paths = (n: number, prefix = 'src/f'): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}.ts`)

const openOf =
  (...open: string[]) =>
  (path: string): boolean =>
    open.includes(path)

const none = (): boolean => false

describe('planPass', () => {
  it('puts open files ahead of the rest without dropping any', () => {
    const plan = planPass(['a.ts', 'b.ts', 'c.ts', 'd.ts'], openOf('c.ts', 'a.ts'))

    // Open files keep their relative order from `affected`, they are not sorted.
    expect(plan.ordered).toEqual(['a.ts', 'c.ts', 'b.ts', 'd.ts'])
  })

  it('guarantees every file of a small pass, so ordinary edits are unaffected', () => {
    const affected = paths(SMALL_PASS_FILES)
    const plan = planPass(affected, none)

    expect(plan.ordered).toHaveLength(SMALL_PASS_FILES)
    expect(plan.guaranteed).toBe(SMALL_PASS_FILES)
  })

  it('guarantees only the open files once a pass is large', () => {
    const affected = [...paths(40), 'open.ts']
    const plan = planPass(affected, openOf('open.ts'))

    expect(plan.ordered[0]).toBe('open.ts')
    expect(plan.guaranteed).toBe(1)
  })

  it('guarantees one file even with nothing open, so a pass always progresses', () => {
    const plan = planPass(paths(40), none)

    // Zero here would mean a watcher-triggered pass with no editor focus checks
    // nothing at all and leans entirely on the drain.
    expect(plan.guaranteed).toBe(1)
  })

  it('guarantees nothing for an empty pass', () => {
    expect(planPass([], none)).toEqual({ ordered: [], guaranteed: 0 })
  })

  it('takes the limit as a parameter so the threshold is testable', () => {
    expect(planPass(paths(5), none, 4).guaranteed).toBe(1)
    expect(planPass(paths(5), none, 5).guaranteed).toBe(5)
  })
})

describe('noteChecked', () => {
  it('records a file that reported diagnostics and clears one that did not', () => {
    const ledger = createLedger()

    noteChecked(ledger, 'a.ts', true)
    expect([...ledger.believedDirty]).toEqual(['a.ts'])

    noteChecked(ledger, 'a.ts', false)
    expect([...ledger.believedDirty]).toEqual([])
  })

  it('settles the debt either way', () => {
    const ledger = createLedger()
    noteDeferred(ledger, ['a.ts', 'b.ts'])

    noteChecked(ledger, 'a.ts', true)
    noteChecked(ledger, 'b.ts', false)

    expect([...ledger.pending]).toEqual([])
  })
})

describe('noteAbandoned', () => {
  it('settles the debt but leaves the last report standing', () => {
    const ledger = createLedger()
    noteChecked(ledger, 'a.ts', true)
    noteDeferred(ledger, ['a.ts'])

    noteAbandoned(ledger, 'a.ts')

    // Nothing new was learned about a.ts, so its squiggles must survive — but it
    // must not be retried forever either.
    expect([...ledger.believedDirty]).toEqual(['a.ts'])
    expect([...ledger.pending]).toEqual([])
  })
})

describe('noteDeferred', () => {
  it('unions across passes instead of replacing', () => {
    const ledger = createLedger()

    noteDeferred(ledger, ['a.ts'])
    noteDeferred(ledger, ['b.ts'])
    noteDeferred(ledger, ['c.ts'])

    // The direct expression of the bug this module replaces: the previous shape
    // assigned, so only the last pass's files survived and everything named
    // earlier was orphaned.
    expect([...ledger.pending].sort()).toEqual(['a.ts', 'b.ts', 'c.ts'])
  })

  it('does not re-add a path that was already checked', () => {
    const ledger = createLedger()

    noteDeferred(ledger, ['a.ts', 'b.ts'])
    noteChecked(ledger, 'a.ts', false)

    expect([...ledger.pending]).toEqual(['b.ts'])
  })
})

describe('nextDrain', () => {
  it('returns a slice in insertion order without mutating', () => {
    const ledger = createLedger()
    noteDeferred(ledger, ['a.ts', 'b.ts', 'c.ts'])

    expect(nextDrain(ledger, 2)).toEqual(['a.ts', 'b.ts'])
    // Still owed — removal is the caller's job, so an interrupted slice does not
    // silently drop its untouched files.
    expect(ledger.pending.size).toBe(3)
  })

  it('is bounded by what is actually outstanding', () => {
    const ledger = createLedger()
    noteDeferred(ledger, ['a.ts'])

    expect(nextDrain(ledger, 10)).toEqual(['a.ts'])
  })

  it('returns nothing for a non-positive slice', () => {
    const ledger = createLedger()
    noteDeferred(ledger, ['a.ts'])

    expect(nextDrain(ledger, 0)).toEqual([])
    expect(nextDrain(ledger, -1)).toEqual([])
  })
})

describe('departed', () => {
  const exists =
    (...present: string[]) =>
    (path: string): boolean =>
      present.includes(path)

  it('reports a file that was dirty passes ago and has since left the graph', () => {
    const ledger = createLedger()
    noteChecked(ledger, 'gone.ts', true)

    // Several unrelated passes happen in between. Under the wholesale
    // replacement this module replaces, gone.ts had already been forgotten by
    // now and its Problems row survived until the daemon restarted.
    noteChecked(ledger, 'other.ts', false)
    noteChecked(ledger, 'another.ts', false)

    expect(departed(ledger, exists('other.ts', 'another.ts'))).toEqual(['gone.ts'])
    expect(ledger.believedDirty.has('gone.ts')).toBe(false)
  })

  it('also stops draining a file that was deleted while it was still owed', () => {
    const ledger = createLedger()
    noteDeferred(ledger, ['gone.ts', 'kept.ts'])

    expect(departed(ledger, exists('kept.ts'))).toEqual(['gone.ts'])
    expect([...ledger.pending]).toEqual(['kept.ts'])
  })

  it('reports a path in both sets exactly once', () => {
    const ledger = createLedger()
    noteChecked(ledger, 'gone.ts', true)
    noteDeferred(ledger, ['gone.ts'])

    expect(departed(ledger, none)).toEqual(['gone.ts'])
  })

  it('says nothing when everything it tracks still exists', () => {
    const ledger: CheckLedger = createLedger()
    noteChecked(ledger, 'a.ts', true)
    noteDeferred(ledger, ['b.ts'])

    expect(departed(ledger, exists('a.ts', 'b.ts'))).toEqual([])
    expect(ledger.believedDirty.size).toBe(1)
    expect(ledger.pending.size).toBe(1)
  })
})
