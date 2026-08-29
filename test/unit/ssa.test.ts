import { describe, expect, it } from 'vitest'
import { parseSource } from '../../src/lang/parser'
import { resolve } from '../../src/lang/symbols'
import { typeCheck } from '../../src/lang/type-check'
import { lower, TOP_LEVEL_FUNCTION } from '../../src/lang/lower'
import { computeDominance, dominatorPreorder } from '../../src/lang/dominance'
import { toSsa, verifySsa } from '../../src/lang/ssa'
import {
  constant,
  printFunction,
  value,
  type Block,
  type BlockId,
  type IrFunction,
  type Terminator
} from '../../src/lang/ir'
import type { Span } from '../../src/lang/token'

/**
 * Dominance and SSA construction.
 *
 * Two things are being tested and they fail differently. Dominance is a pure
 * graph computation with a known right answer, so it is checked against
 * hand-worked expectations on graphs small enough to verify by eye — including
 * an IRREDUCIBLE one, which BCC's own lowering can never produce but which the
 * algorithm claims to handle.
 *
 * SSA construction fails silently. A phi with an argument from the wrong edge,
 * or a use that its definition does not actually reach, produces IR that looks
 * fine and computes the wrong thing three stages later. So `verifySsa` checks
 * the property directly — every use dominated by its definition — and it runs
 * over every program in the corpus rather than over a chosen few.
 */

const SPAN: Span = {
  offset: 0,
  length: 0,
  startLine: 1,
  startColumn: 1,
  endLine: 1,
  endColumn: 1
}

/** A CFG with no instructions — enough to test dominance on its own. */
function graph(edges: readonly (readonly BlockId[])[]): IrFunction {
  const blocks: Block[] = edges.map((targets, id) => {
    let terminator: Terminator
    if (targets.length === 0) terminator = { op: 'return', value: null, span: SPAN }
    else if (targets.length === 1) {
      terminator = { op: 'jump', target: targets[0]!, span: SPAN }
    } else {
      terminator = {
        op: 'branch',
        condition: constant(true),
        ifTrue: targets[0]!,
        ifFalse: targets[1]!,
        span: SPAN
      }
    }
    return { id, label: `b${id}`, instructions: [], terminator }
  })

  return {
    name: 'graph',
    params: [],
    returnType: { kind: 'unit' },
    blocks,
    entry: 0,
    span: SPAN
  }
}

function irFor(source: string): IrFunction {
  const { program, diagnostics } = parseSource(source)
  expect(diagnostics, `parse errors in ${JSON.stringify(source)}`).toEqual([])
  const resolution = resolve(program)
  const types = typeCheck(program, resolution)
  const module = lower(program, resolution, types)
  const fn = module.functions.find((candidate) => candidate.name === TOP_LEVEL_FUNCTION)
  if (fn === undefined) throw new Error('no top-level function')
  return fn
}

function namedIr(source: string, name: string): IrFunction {
  const { program, diagnostics } = parseSource(source)
  expect(diagnostics).toEqual([])
  const resolution = resolve(program)
  const types = typeCheck(program, resolution)
  const fn = lower(program, resolution, types).functions.find(
    (candidate) => candidate.name === name
  )
  if (fn === undefined) throw new Error(`no function called ${name}`)
  return fn
}

/* -------------------------------------------------------------------------- */
/*  Dominance                                                                  */
/* -------------------------------------------------------------------------- */

describe('dominance — shapes worked out by hand', () => {
  it('makes a straight line a chain', () => {
    //  0 -> 1 -> 2
    const dominance = computeDominance(graph([[1], [2], []]))
    expect(dominance.idom.get(1)).toBe(0)
    expect(dominance.idom.get(2)).toBe(1)
    expect(dominance.dominates(0, 2)).toBe(true)
    expect(dominance.dominates(2, 0)).toBe(false)
  })

  it('gives a diamond a join dominated by the split', () => {
    //      0
    //     / \
    //    1   2
    //     \ /
    //      3
    const dominance = computeDominance(graph([[1, 2], [3], [3], []]))

    // The join is dominated by the SPLIT, not by either arm — every path to it
    // goes through 0, and no path is forced through 1 or 2.
    expect(dominance.idom.get(3)).toBe(0)
    expect(dominance.dominates(1, 3)).toBe(false)
    expect(dominance.dominates(2, 3)).toBe(false)
    expect(dominance.dominates(0, 3)).toBe(true)
  })

  it('puts the join in the frontier of both arms', () => {
    // This is the whole reason the frontier exists: a value defined in 1 can
    // meet a different value from 2 at exactly block 3.
    const dominance = computeDominance(graph([[1, 2], [3], [3], []]))
    expect([...(dominance.frontier.get(1) ?? [])]).toEqual([3])
    expect([...(dominance.frontier.get(2) ?? [])]).toEqual([3])
    expect([...(dominance.frontier.get(0) ?? [])]).toEqual([])
  })

  it('makes a loop header dominate its own body', () => {
    //  0 -> 1 <-> 2,  1 -> 3
    const dominance = computeDominance(graph([[1], [2, 3], [1], []]))
    expect(dominance.idom.get(1)).toBe(0)
    expect(dominance.idom.get(2)).toBe(1)
    expect(dominance.idom.get(3)).toBe(1)
    expect(dominance.dominates(1, 2)).toBe(true)
  })

  it('puts a loop header in its own frontier, through the back edge', () => {
    // The header is where a value from the body meets the value from before
    // the loop — which is why a loop-carried variable gets its phi there.
    const dominance = computeDominance(graph([[1], [2, 3], [1], []]))
    expect([...(dominance.frontier.get(2) ?? [])]).toEqual([1])
  })

  it('keeps nested loops apart', () => {
    //  0 -> 1 -> 2 -> 3 -> 2 (inner back edge)
    //            3 -> 4 -> 1 (outer back edge)
    const dominance = computeDominance(graph([[1], [2], [3], [2, 4], [1, 5], []]))
    expect(dominance.idom.get(2)).toBe(1)
    expect(dominance.idom.get(3)).toBe(2)

    // Block 3 is in BOTH headers' frontiers, and that is the interesting part
    // of a nested loop rather than a surprise. It is the inner latch, so it
    // reaches the inner header; and it is also on the only path to the outer
    // latch, so a value defined there reaches the outer header too. A variable
    // written in the inner body therefore needs a phi at both.
    expect([...(dominance.frontier.get(3) ?? [])].sort()).toEqual([1, 2])

    // Block 4 is only on the outer back edge, so it reaches only the outer
    // header — it cannot get back to the inner one without passing 1 first.
    expect([...(dominance.frontier.get(4) ?? [])]).toEqual([1])
  })

  /**
   * A loop with two entries — nothing BCC lowers can produce, because `while`
   * is the only loop and it has exactly one way in.
   *
   * It is here because the iterative algorithm CLAIMS to handle irreducible
   * graphs, and a claim nobody tests is a comment. If the fixed point were
   * written as a single sweep it would give the wrong answer on exactly this
   * shape.
   */
  it('handles an irreducible graph, which nothing here can produce', () => {
    //      0
    //     / \
    //    1 <-> 2      both 1 and 2 are entries to the same cycle
    const dominance = computeDominance(graph([[1, 2], [2], [1]]))

    // Neither 1 nor 2 dominates the other: each can be reached without the
    // other, so the entry is the immediate dominator of both.
    expect(dominance.idom.get(1)).toBe(0)
    expect(dominance.idom.get(2)).toBe(0)
    expect(dominance.dominates(1, 2)).toBe(false)
    expect(dominance.dominates(2, 1)).toBe(false)
    expect(dominance.dominates(0, 1)).toBe(true)
    expect(dominance.dominates(0, 2)).toBe(true)
  })

  it('leaves an unreachable block out entirely', () => {
    // No path reaches it, so there is nothing to dominate it. Inventing a
    // dominator would make `dominates` answer about paths that do not exist.
    const fn = graph([[1], [], []])
    const dominance = computeDominance(fn)
    expect(dominance.reachable.has(2)).toBe(false)
    expect(dominance.idom.has(2)).toBe(false)
    expect(dominance.dominates(0, 2)).toBe(false)
  })

  it('walks the dominator tree parents before children', () => {
    const dominance = computeDominance(graph([[1, 2], [3], [3], []]))
    const order = dominatorPreorder(dominance, 0)
    expect(order[0]).toBe(0)
    expect(new Set(order)).toEqual(new Set([0, 1, 2, 3]))
    for (const id of order) {
      const parent = dominance.idom.get(id)
      if (parent === undefined || parent === id) continue
      expect(order.indexOf(parent)).toBeLessThan(order.indexOf(id))
    }
  })

  it('is reflexive and transitive', () => {
    const dominance = computeDominance(graph([[1], [2], [3], []]))
    for (const id of [0, 1, 2, 3]) expect(dominance.dominates(id, id)).toBe(true)
    expect(dominance.strictlyDominates(1, 1)).toBe(false)
    expect(dominance.dominates(0, 1) && dominance.dominates(1, 2)).toBe(true)
    expect(dominance.dominates(0, 2)).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/*  SSA construction                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Every program the invariant runs over.
 *
 * Weighted towards the shapes that need a phi at all: a variable written in one
 * arm of an `if`, a loop counter, a variable written in both arms, a
 * short-circuit. Straight-line code needs none, so it proves little.
 */
const CORPUS: readonly string[] = [
  'let x = 1; print x;',
  'let x = 1; x = 2; print x;',
  'let x = 1; if true { x = 2; } print x;',
  'let x = 1; if true { x = 2; } else { x = 3; } print x;',
  'let x = 1; if true { x = 2; } else { } print x;',
  'let i = 0; while i < 10 { i = i + 1; } print i;',
  'let i = 0; let total = 0; while i < 10 { total = total + i; i = i + 1; } print total;',
  'let i = 0; while i < 3 { let j = 0; while j < 3 { j = j + 1; } i = i + 1; } print i;',
  'let x = 1; while x < 10 { if x > 5 { x = x + 2; } else { x = x + 1; } } print x;',
  'print true && false;',
  'print true || false;',
  'let a = true; let b = false; print a && b || !a;',
  'let x = 1; if x > 0 && x < 10 { x = 0; } print x;',
  'fn f(a: int) -> int { if a > 0 { return a; } return 0; }',
  'fn f(a: int) -> int { let b = a; while b > 0 { b = b - 1; } return b; }',
  'fn fib(n: int) -> int { if n < 2 { return n; } return fib(n - 1) + fib(n - 2); }',
  'fn f(a: int, b: int) -> int { let c = a; if a > b { c = b; } return c; }'
]

describe('SSA — the invariant, on every program', () => {
  const everyFunction = (): { source: string; fn: IrFunction }[] =>
    CORPUS.flatMap((source) => {
      const { program } = parseSource(source)
      const resolution = resolve(program)
      const types = typeCheck(program, resolution)
      return lower(program, resolution, types).functions.map((fn) => ({ source, fn }))
    })

  /**
   * The one thing SSA promises, checked directly rather than inferred from the
   * output looking plausible.
   */
  it('leaves every use dominated by its definition', () => {
    for (const { source, fn } of everyFunction()) {
      const problems = verifySsa(toSsa(fn))
      expect(problems, `${fn.name} in ${JSON.stringify(source)}`).toEqual([])
    }
  })

  it('still defines every value exactly once', () => {
    for (const { source, fn } of everyFunction()) {
      const ssa = toSsa(fn)
      const seen = new Set<number>()
      for (const param of ssa.params) seen.add(param.value)
      for (const block of ssa.blocks) {
        for (const instruction of block.instructions) {
          if (!('result' in instruction) || instruction.result === null) continue
          const result = instruction.result
          expect(seen.has(result), `%${result} twice in ${JSON.stringify(source)}`).toBe(false)
          seen.add(result)
        }
      }
    }
  })

  it('gives every phi one argument per incoming edge', () => {
    // Arity is per EDGE, not per predecessor block. `branch %c, join, join`
    // reaches the join twice from one block and needs two arguments.
    for (const { source, fn } of everyFunction()) {
      const ssa = toSsa(fn)
      expect(verifySsa(ssa), JSON.stringify(source)).toEqual([])
    }
  })

  it('puts every phi at the start of its block', () => {
    for (const { source, fn } of everyFunction()) {
      for (const block of toSsa(fn).blocks) {
        let seenOther = false
        for (const instruction of block.instructions) {
          if (instruction.op === 'phi') {
            expect(seenOther, `${block.label} in ${JSON.stringify(source)}`).toBe(false)
          } else {
            seenOther = true
          }
        }
      }
    }
  })

  it('removes every promoted alloca, load and store', () => {
    // BCC has no address-of, so every slot is promotable and none should
    // survive. A leftover load is a variable that stayed in memory.
    for (const { source, fn } of everyFunction()) {
      const ops = toSsa(fn).blocks.flatMap((block) =>
        block.instructions.map((instruction) => instruction.op)
      )
      expect(ops, JSON.stringify(source)).not.toContain('alloca')
      expect(ops, JSON.stringify(source)).not.toContain('load')
      expect(ops, JSON.stringify(source)).not.toContain('store')
    }
  })

  it('keeps the control-flow graph exactly as it was', () => {
    // SSA is a change of how values are named, not of where control goes. A
    // pass that moved a branch would be doing something else.
    for (const { source, fn } of everyFunction()) {
      const ssa = toSsa(fn)
      expect(ssa.blocks.map((block) => block.id), JSON.stringify(source)).toEqual(
        fn.blocks.map((block) => block.id)
      )
      expect(
        ssa.blocks.map((block) => JSON.stringify(block.terminator.op)),
        JSON.stringify(source)
      ).toEqual(fn.blocks.map((block) => JSON.stringify(block.terminator.op)))
    }
  })
})

/* -------------------------------------------------------------------------- */
/*  What the output looks like                                                 */
/* -------------------------------------------------------------------------- */

describe('SSA — the shapes a reader will recognise', () => {
  it('needs no phi for straight-line code', () => {
    // One definition reaches every use already. A phi here would be noise.
    expect(printFunction(toSsa(irFor('let x = 1; print x;')))).toBe(
      ['fn <main>() -> unit {', 'entry.0:', '  print 1', '  ret', '}'].join('\n')
    )
  })

  it('puts a phi at the join of an if/else', () => {
    const text = printFunction(toSsa(irFor('let x = 1; if true { x = 2; } else { x = 3; } print x;')))
    expect(text).toContain('phi x [then.1, 2], [else.2, 3]')
    // And the print reads the phi rather than a load.
    expect(text).not.toContain('load')
  })

  it('takes the value from before the if on the path that skips it', () => {
    // The false edge carries the ORIGINAL value. Getting this wrong is the
    // classic phi bug and it is invisible without running the program.
    // Arguments run in predecessor order, which is block-id order, so the
    // fall-through edge from `entry` comes first.
    const text = printFunction(toSsa(irFor('let x = 1; if true { x = 2; } print x;')))
    expect(text).toContain('phi x [entry.0, 1], [then.1, 2]')
  })

  it('puts a phi at a loop header, carrying the back edge', () => {
    /*
     * Pinned as a whole function rather than as a pattern, because the
     * VALUE on each arm is the part that can be wrong.
     *
     * `verifySsa` cannot catch a phi that takes a well-formed value from the
     * wrong edge — the result dominates, the arity matches, and the program
     * computes something else. Semantic equivalence gets proven properly in
     * Part 9, against the real VM; until then this is the check that the loop
     * carries `i + 1` back and starts from `0`, in that order.
     */
    expect(printFunction(toSsa(irFor('let i = 0; while i < 10 { i = i + 1; } print i;')))).toBe(
      [
        'fn <main>() -> unit {',
        'entry.0:',
        '  jump while.head.1',
        'while.head.1:',
        '  %6 = phi i [entry.0, 0], [while.body.2, %4]',
        '  %2 = < %6, 10',
        '  branch %2, while.body.2, while.exit.3',
        'while.body.2:',
        '  %4 = + %6, 1',
        '  jump while.head.1',
        'while.exit.3:',
        '  print %6',
        '  ret',
        '}'
      ].join('\n')
    )
  })

  it('turns a short-circuit slot into a phi', () => {
    /*
     * The demonstration the whole plan is built around. In Part 5 `&&` lowered
     * to a branch, a slot and a join; here the slot is gone and the join holds
     * a phi. Same control flow, no memory.
     */
    const text = printFunction(toSsa(irFor('print true && false;')))
    expect(text).toBe(
      [
        'fn <main>() -> unit {',
        'entry.0:',
        '  branch true, and.rhs.1, and.join.2',
        'and.rhs.1:',
        '  jump and.join.2',
        'and.join.2:',
        '  %2 = phi and [entry.0, true], [and.rhs.1, false]',
        '  print %2',
        '  ret',
        '}'
      ].join('\n')
    )
  })

  it('promotes a parameter, dropping the copy the lowering made', () => {
    // Part 5 copied every parameter into a slot because BCC lets you assign to
    // one. When nothing does, the copy disappears entirely.
    const text = printFunction(toSsa(namedIr('fn add(a: int, b: int) -> int { return a + b; }', 'add')))
    expect(text).toBe(
      [
        'fn add(%0: int, %1: int) -> int {',
        'entry.0:',
        '  %6 = + %0, %1',
        '  ret %6',
        '}'
      ].join('\n')
    )
  })

  it('keeps a phi for a parameter that is assigned to', () => {
    const text = printFunction(
      toSsa(namedIr('fn f(a: int) -> int { while a > 0 { a = a - 1; } return a; }', 'f'))
    )
    expect(text).toContain('phi a [')
  })

  it('leaves a function with no variables untouched', () => {
    const before = namedIr('fn f() { print 1; }', 'f')
    expect(printFunction(toSsa(before))).toBe(printFunction(before))
  })

  it('is idempotent', () => {
    // Running it twice must change nothing: there are no allocas left to
    // promote, so the second pass has no work.
    const once = toSsa(irFor('let x = 1; if true { x = 2; } print x;'))
    expect(printFunction(toSsa(once))).toBe(printFunction(once))
  })
})

/* -------------------------------------------------------------------------- */
/*  The verifier itself                                                        */
/* -------------------------------------------------------------------------- */

describe('verifySsa catches what it claims to', () => {
  const base = (): IrFunction => toSsa(irFor('let x = 1; if true { x = 2; } else { x = 3; } print x;'))

  it('accepts well-formed SSA', () => {
    expect(verifySsa(base())).toEqual([])
  })

  it('rejects a use its definition does not reach', () => {
    // A value defined in one arm of the diamond, used in the other. It looks
    // like ordinary IR and is exactly what a broken renaming produces.
    const fn = base()
    const blocks = fn.blocks.map((block) =>
      block.label.startsWith('else')
        ? {
            ...block,
            instructions: [
              ...block.instructions,
              { op: 'print' as const, value: value(999), span: SPAN }
            ]
          }
        : block
    )
    const problems = verifySsa({ ...fn, blocks })
    expect(problems.join(' ')).toMatch(/never defined/)
  })

  it('rejects a phi whose arity does not match its edges', () => {
    const fn = base()
    const blocks = fn.blocks.map((block) => ({
      ...block,
      instructions: block.instructions.map((instruction) =>
        instruction.op === 'phi'
          ? { ...instruction, incoming: instruction.incoming.slice(0, 1) }
          : instruction
      )
    }))
    expect(verifySsa({ ...fn, blocks }).join(' ')).toMatch(/arguments for 2 incoming edges/)
  })

  it('rejects a phi that is not at the start of its block', () => {
    const fn = base()
    const blocks = fn.blocks.map((block) => {
      const phiIndex = block.instructions.findIndex((instruction) => instruction.op === 'phi')
      if (phiIndex < 0) return block
      const reordered = [...block.instructions]
      const [phi] = reordered.splice(phiIndex, 1)
      if (phi === undefined) return block
      reordered.push(phi)
      return { ...block, instructions: reordered }
    })
    expect(verifySsa({ ...fn, blocks }).join(' ')).toMatch(/phi appears after a non-phi/)
  })

  it('rejects a value defined twice', () => {
    const fn = base()

    // Duplicate an id the function ACTUALLY defines. Picking an arbitrary
    // number would not be a second definition of anything — promotion has
    // already deleted most of the low ids, which is how the first version of
    // this test passed against a verifier that was doing nothing.
    const existing = fn.blocks
      .flatMap((block) => block.instructions)
      .flatMap((instruction) => ('result' in instruction && instruction.result !== null ? [instruction.result] : []))
    const duplicate = existing[0]
    expect(duplicate, 'nothing is defined, so there is nothing to duplicate').toBeDefined()

    const first = fn.blocks[0]
    if (first === undefined || duplicate === undefined) throw new Error('no entry block')

    const blocks = [
      {
        ...first,
        instructions: [
          ...first.instructions,
          {
            op: 'binary' as const,
            result: duplicate,
            operator: '+' as const,
            left: constant(1),
            right: constant(1),
            span: SPAN
          }
        ]
      },
      ...fn.blocks.slice(1)
    ]

    expect(verifySsa({ ...fn, blocks }).join(' ')).toMatch(/defined more than once/)
  })

  it('rejects a use before its definition inside one block', () => {
    const fn = base()
    const first = fn.blocks[0]
    if (first === undefined) throw new Error('no entry block')
    const blocks = [
      {
        ...first,
        instructions: [
          { op: 'print' as const, value: value(500), span: SPAN },
          { op: 'binary' as const, result: 500, operator: '+' as const, left: constant(1), right: constant(1), span: SPAN }
        ]
      },
      ...fn.blocks.slice(1)
    ]
    expect(verifySsa({ ...fn, blocks }).join(' ')).toMatch(/used before it is defined/)
  })
})
