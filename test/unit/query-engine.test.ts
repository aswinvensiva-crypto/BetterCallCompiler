import { describe, expect, it } from 'vitest'
import {
  QueryCycleError,
  argumentOf,
  createEngine,
  namespaceOf,
  queryKey,
  type QueryTrace
} from '../../src/shared/query-engine'

/**
 * These tests are the specification for the three mechanisms the engine exists
 * for — durability, early cutoff, and laziness. Each one is written so that
 * removing the mechanism fails the test with an obvious message rather than a
 * subtle count being off by one.
 */

function tracingEngine(): { engine: ReturnType<typeof createEngine>; traces: QueryTrace[] } {
  const traces: QueryTrace[] = []
  // A monotonic fake clock: real `Date.now()` makes `ms` non-deterministic and
  // nothing here is asserting on timing.
  let clock = 0
  const engine = createEngine({
    onTrace: (trace) => traces.push(trace),
    now: () => clock++
  })
  return { engine, traces }
}

describe('query keys', () => {
  it('splits on the first colon so Windows paths survive', () => {
    const key = queryKey('fileText', 'C:/ws/src/a.ts')
    expect(namespaceOf(key)).toBe('fileText')
    expect(argumentOf(key)).toBe('C:/ws/src/a.ts')
  })
})

describe('laziness', () => {
  /**
   * The headline claim. An edit must not cause computation; only a `get` may.
   * If this fails, the engine has become eager and the whole point is gone.
   */
  it('does not compute anything until something is asked for', () => {
    const { engine } = tracingEngine()
    let computed = 0

    engine.defineQuery('double', (arg, ctx) => {
      computed++
      return ctx.get<number>(queryKey('n', arg)) * 2
    })

    engine.setInput(queryKey('n', 'a'), 1)
    engine.setInput(queryKey('n', 'a'), 2)
    engine.setInput(queryKey('n', 'a'), 3)

    expect(computed).toBe(0)

    expect(engine.get(queryKey('double', 'a'))).toBe(6)
    expect(computed).toBe(1)
  })

  it('serves a second get in the same revision without recomputing', () => {
    const { engine, traces } = tracingEngine()
    let computed = 0

    engine.defineQuery('double', (arg, ctx) => {
      computed++
      return ctx.get<number>(queryKey('n', arg)) * 2
    })

    engine.setInput(queryKey('n', 'a'), 4)
    engine.get(queryKey('double', 'a'))
    engine.get(queryKey('double', 'a'))

    expect(computed).toBe(1)
    expect(traces.filter((t) => t.key === 'double:a').map((t) => t.outcome)).toEqual([
      'miss',
      'fresh'
    ])
  })
})

describe('durability', () => {
  /**
   * The mechanism that pays for itself on real projects. A memo derived only
   * from `lib`-durability inputs must survive a workspace edit WITHOUT its
   * dependencies being walked — one integer comparison instead of a subgraph.
   */
  it('serves a lib-durability memo across a workspace edit without walking deps', () => {
    const { engine, traces } = tracingEngine()

    engine.defineQuery('fromLib', (arg, ctx) => ctx.get<number>(queryKey('lib', arg)) + 1)

    engine.setInput(queryKey('lib', 'x'), 10, 'lib')
    engine.setInput(queryKey('ws', 'y'), 1, 'workspace')

    expect(engine.get(queryKey('fromLib', 'x'))).toBe(11)

    // An unrelated workspace edit — the situation on every keystroke.
    engine.setInput(queryKey('ws', 'y'), 2, 'workspace')

    traces.length = 0
    expect(engine.get(queryKey('fromLib', 'x'))).toBe(11)

    const trace = traces.find((t) => t.key === 'fromLib:x')
    expect(trace?.outcome).toBe('durable')
    expect(trace?.depsWalked).toBe(0)
    expect(engine.stats().durableSkips).toBe(1)
  })

  /**
   * The inverse, and the classic durability bug if it is wrong: changing a
   * *stable* input must still invalidate memos built on volatile ones. If
   * `markChanged` only stamped its own tier, this would return the stale value.
   */
  it('invalidates a workspace-durability memo when a lib input changes', () => {
    const { engine } = tracingEngine()

    engine.defineQuery('sum', (arg, ctx) =>
      ctx.get<number>(queryKey('lib', arg)) + ctx.get<number>(queryKey('ws', arg))
    )

    engine.setInput(queryKey('lib', 'a'), 100, 'lib')
    engine.setInput(queryKey('ws', 'a'), 1, 'workspace')
    expect(engine.get(queryKey('sum', 'a'))).toBe(101)

    engine.setInput(queryKey('lib', 'a'), 200, 'lib')
    expect(engine.get(queryKey('sum', 'a'))).toBe(201)
  })

  it('takes the minimum durability across dependencies', () => {
    const { engine, traces } = tracingEngine()

    engine.defineQuery('mixed', (arg, ctx) =>
      ctx.get<number>(queryKey('lib', arg)) + ctx.get<number>(queryKey('ws', arg))
    )

    engine.setInput(queryKey('lib', 'a'), 1, 'lib')
    engine.setInput(queryKey('ws', 'a'), 2, 'workspace')
    engine.get(queryKey('mixed', 'a'))

    // A memo is exactly as stable as its least stable input.
    expect(traces.find((t) => t.key === 'mixed:a')?.durability).toBe('workspace')
  })
})

describe('early cutoff', () => {
  /**
   * Reformatting a file changes its text and none of its diagnostics. Without
   * cutoff that edit rechecks every dependent for nothing — which is precisely
   * the waste this engine was written to remove.
   */
  it('stops propagation when a recomputed value is unchanged', () => {
    const { engine, traces } = tracingEngine()
    let downstreamRuns = 0

    // Deliberately discards the input's actual value: recomputing it always
    // yields the same answer, which is what a formatting-only edit looks like.
    engine.defineQuery('parity', (arg, ctx) => {
      const n = ctx.get<number>(queryKey('n', arg))
      return n % 2 === 0 ? 'even' : 'odd'
    })

    engine.defineQuery('label', (arg, ctx) => {
      downstreamRuns++
      return `is ${ctx.get<string>(queryKey('parity', arg))}`
    })

    engine.setInput(queryKey('n', 'a'), 2)
    expect(engine.get(queryKey('label', 'a'))).toBe('is even')
    expect(downstreamRuns).toBe(1)

    // 2 -> 4: the input changed, `parity` must rerun, and its answer is identical.
    engine.setInput(queryKey('n', 'a'), 4)
    traces.length = 0
    expect(engine.get(queryKey('label', 'a'))).toBe('is even')

    expect(traces.find((t) => t.key === 'parity:a')?.outcome).toBe('cutoff')
    expect(traces.find((t) => t.key === 'label:a')?.outcome).toBe('validated')
    expect(downstreamRuns).toBe(1)
    expect(engine.stats().cutoffs).toBe(1)
  })

  it('propagates when the recomputed value really differs', () => {
    const { engine } = tracingEngine()
    let downstreamRuns = 0

    engine.defineQuery('parity', (arg, ctx) =>
      ctx.get<number>(queryKey('n', arg)) % 2 === 0 ? 'even' : 'odd'
    )
    engine.defineQuery('label', (arg, ctx) => {
      downstreamRuns++
      return `is ${ctx.get<string>(queryKey('parity', arg))}`
    })

    engine.setInput(queryKey('n', 'a'), 2)
    engine.get(queryKey('label', 'a'))

    engine.setInput(queryKey('n', 'a'), 3)
    expect(engine.get(queryKey('label', 'a'))).toBe('is odd')
    expect(downstreamRuns).toBe(2)
  })

  it('uses a registered equality so structural results can cut off too', () => {
    const { engine, traces } = tracingEngine()

    // Diagnostics arrive as fresh arrays every pass; `Object.is` would never
    // cut off on them, which would make the mechanism useless for the daemon's
    // single most important query.
    engine.defineQuery(
      'diagnostics',
      (arg, ctx) => (ctx.get<number>(queryKey('n', arg)) > 0 ? ['TS2345'] : []),
      (a, b) => JSON.stringify(a) === JSON.stringify(b)
    )

    engine.setInput(queryKey('n', 'a'), 1)
    engine.get(queryKey('diagnostics', 'a'))

    engine.setInput(queryKey('n', 'a'), 2)
    traces.length = 0
    engine.get(queryKey('diagnostics', 'a'))

    expect(traces.find((t) => t.key === 'diagnostics:a')?.outcome).toBe('cutoff')
  })
})

describe('inputs', () => {
  /**
   * A save-on-focus-loss editor fires watcher events constantly for files whose
   * bytes did not change. Bumping the revision on those would invalidate the
   * world all day for nothing.
   */
  it('does not bump the revision when an input is written with the same value', () => {
    const { engine } = tracingEngine()

    engine.setInput(queryKey('n', 'a'), 1)
    const before = engine.revision()

    expect(engine.setInput(queryKey('n', 'a'), 1)).toBe(false)
    expect(engine.revision()).toBe(before)

    expect(engine.setInput(queryKey('n', 'a'), 2)).toBe(true)
    expect(engine.revision()).toBeGreaterThan(before)
  })

  it('invalidates dependents when an input is removed', () => {
    const { engine } = tracingEngine()

    engine.defineQuery('read', (arg, ctx) => {
      try {
        return ctx.get<number>(queryKey('n', arg))
      } catch {
        return -1
      }
    })

    engine.setInput(queryKey('n', 'a'), 5)
    expect(engine.get(queryKey('read', 'a'))).toBe(5)

    expect(engine.removeInput(queryKey('n', 'a'))).toBe(true)
    // The file is gone; the query namespace has no compute, so `read` catches.
    expect(engine.get(queryKey('read', 'a'))).toBe(-1)
    expect(engine.removeInput(queryKey('n', 'a'))).toBe(false)
  })

  it('keeps inputs but drops derived memos on invalidateDerived', () => {
    const { engine } = tracingEngine()
    let computed = 0

    engine.defineQuery('double', (arg, ctx) => {
      computed++
      return ctx.get<number>(queryKey('n', arg)) * 2
    })

    engine.setInput(queryKey('n', 'a'), 3)
    engine.get(queryKey('double', 'a'))
    expect(computed).toBe(1)

    // A tsconfig change: contents are fine, the program's shape is not.
    engine.invalidateDerived()

    expect(engine.keys()).toContain('n:a')
    expect(engine.keys()).not.toContain('double:a')
    expect(engine.get(queryKey('double', 'a'))).toBe(6)
    expect(computed).toBe(2)
  })
})

describe('cycles', () => {
  /**
   * Import cycles are legal TypeScript and this engine runs inside a daemon
   * that must survive them. A cycle is an error object, not a stack overflow.
   */
  it('reports a cycle as a path instead of recursing forever', () => {
    const { engine } = tracingEngine()

    engine.defineQuery('a', (arg, ctx) => ctx.get(queryKey('b', arg)))
    engine.defineQuery('b', (arg, ctx) => ctx.get(queryKey('a', arg)))

    let caught: unknown
    try {
      engine.get(queryKey('a', 'x'))
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(QueryCycleError)
    expect((caught as QueryCycleError).cycle).toEqual(['a:x', 'b:x', 'a:x'])
  })

  it('leaves the engine usable after a cycle', () => {
    const { engine } = tracingEngine()

    engine.defineQuery('a', (arg, ctx) => ctx.get(queryKey('b', arg)))
    engine.defineQuery('b', (arg, ctx) => ctx.get(queryKey('a', arg)))
    engine.defineQuery('fine', (arg, ctx) => ctx.get<number>(queryKey('n', arg)) + 1)

    expect(() => engine.get(queryKey('a', 'x'))).toThrow(QueryCycleError)

    // The in-progress stack must have unwound, or this throws a bogus cycle.
    engine.setInput(queryKey('n', 'y'), 1)
    expect(engine.get(queryKey('fine', 'y'))).toBe(2)
  })
})

describe('deep chains', () => {
  /**
   * The shape a real dependency graph has: a long chain where an edit at the
   * bottom must reach the top, and a *second* get must not walk it again.
   */
  it('validates a 200-deep chain once and then serves it fresh', () => {
    const { engine } = tracingEngine()
    const DEPTH = 200

    engine.defineQuery('link', (arg, ctx) => {
      const level = Number(arg)
      if (level === 0) return ctx.get<number>(queryKey('n', 'seed'))
      return ctx.get<number>(queryKey('link', String(level - 1))) + 1
    })

    engine.setInput(queryKey('n', 'seed'), 0)
    expect(engine.get(queryKey('link', String(DEPTH)))).toBe(DEPTH)

    engine.setInput(queryKey('n', 'seed'), 1000)
    expect(engine.get(queryKey('link', String(DEPTH)))).toBe(1000 + DEPTH)

    const before = engine.stats().recomputes
    engine.get(queryKey('link', String(DEPTH)))
    expect(engine.stats().recomputes).toBe(before)
  })

  it('reports isValid without doing work', () => {
    const { engine, traces } = tracingEngine()

    engine.defineQuery('double', (arg, ctx) => ctx.get<number>(queryKey('n', arg)) * 2)
    engine.setInput(queryKey('n', 'a'), 2)
    engine.get(queryKey('double', 'a'))

    traces.length = 0
    expect(engine.isValid(queryKey('double', 'a'))).toBe(true)
    expect(engine.isValid(queryKey('double', 'missing'))).toBe(false)
    expect(traces).toEqual([])
  })
})

describe('dependency recording', () => {
  it('records one edge for a dependency read twice', () => {
    const { engine } = tracingEngine()

    engine.defineQuery('twice', (arg, ctx) => {
      const n = ctx.get<number>(queryKey('n', arg))
      const again = ctx.get<number>(queryKey('n', arg))
      return n + again
    })

    engine.setInput(queryKey('n', 'a'), 3)
    expect(engine.get(queryKey('twice', 'a'))).toBe(6)
    expect(engine.dependenciesOf(queryKey('twice', 'a'))).toEqual(['n:a'])
  })

  it('drops an edge that a recompute no longer reads', () => {
    const { engine } = tracingEngine()

    engine.defineQuery('branch', (arg, ctx) =>
      ctx.get<boolean>(queryKey('flag', arg))
        ? ctx.get<number>(queryKey('left', arg))
        : ctx.get<number>(queryKey('right', arg))
    )

    engine.setInput(queryKey('flag', 'a'), true)
    engine.setInput(queryKey('left', 'a'), 1)
    engine.setInput(queryKey('right', 'a'), 2)
    engine.get(queryKey('branch', 'a'))
    expect(engine.dependenciesOf(queryKey('branch', 'a'))).toEqual(['flag:a', 'left:a'])

    engine.setInput(queryKey('flag', 'a'), false)
    engine.get(queryKey('branch', 'a'))

    // Stale edges would widen the invalidation set forever — the same bug
    // `upsertNode` in dependency-graph.ts diffs its imports to avoid.
    expect(engine.dependenciesOf(queryKey('branch', 'a'))).toEqual(['flag:a', 'right:a'])
  })

  it('throws a readable error for an unregistered namespace', () => {
    const { engine } = tracingEngine()
    expect(() => engine.get(queryKey('nope', 'a'))).toThrow(/no query registered/)
  })
})
