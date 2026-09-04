import { describe, expect, it } from 'vitest'
import { parseSource } from '../../src/lang/parser'
import { resolve } from '../../src/lang/symbols'
import { typeCheck } from '../../src/lang/type-check'
import { lower } from '../../src/lang/lower'
import { printFunction, type IrFunction, type Module } from '../../src/lang/ir'
import { runPipeline } from '../../src/lang/pass-manager'
import { constantFolding } from '../../src/lang/passes/const-fold'
import { verifyModule } from '../../src/lang/verify'

/**
 * Constant folding.
 *
 * Every case here goes through `runPipeline` rather than calling the pass
 * directly, so the verifier runs on the output of each one. A pass tested in
 * isolation can produce IR that is subtly malformed and still satisfy an
 * assertion about the instruction the test was looking at; that is exactly the
 * failure the pass manager exists to catch, so the tests use it.
 */

function moduleFor(source: string): Module {
  const { program, diagnostics } = parseSource(source)
  expect(diagnostics, `parse errors in ${JSON.stringify(source)}`).toEqual([])
  const resolution = resolve(program)
  return lower(program, resolution, typeCheck(program, resolution))
}

/** The folded IR of the top-level function, as text. */
function foldedText(source: string): string {
  const report = runPipeline(moduleFor(source), [constantFolding])
  expect(report.failure, report.failure?.message).toBeNull()
  return printFunction(report.module.functions[0] as IrFunction)
}

function foldedModule(source: string): Module {
  const report = runPipeline(moduleFor(source), [constantFolding])
  expect(report.failure, report.failure?.message).toBeNull()
  return report.module
}

describe('arithmetic', () => {
  it('folds an addition down to its result', () => {
    const text = foldedText('print 1 + 2;')
    expect(text).toContain('print 3')
    // The instruction is gone, not rewritten — there is no instruction that
    // produces a constant, so folding means deleting and substituting.
    expect(text).not.toMatch(/= \+ /)
  })

  it.each([
    ['print 7 - 3;', 'print 4'],
    ['print 6 * 7;', 'print 42'],
    ['print 9 / 2;', 'print 4'],
    ['print 9 % 2;', 'print 1'],
    ['print -5 + 1;', 'print -4']
  ])('folds %j to %j', (source, expected) => {
    expect(foldedText(source)).toContain(expected)
  })

  it('truncates division rather than producing a fraction', () => {
    // BCC's only numeric type is `int`. `9 / 2` is 4, and folding it to 4.5
    // would make the constant and the runtime disagree.
    expect(foldedText('print 9 / 2;')).toContain('print 4')
    expect(foldedText('print -9 / 2;')).toContain('print -4')
  })
})

describe('comparisons and booleans', () => {
  it.each([
    ['print 1 < 2;', 'print true'],
    ['print 2 <= 2;', 'print true'],
    ['print 3 > 4;', 'print false'],
    ['print 3 >= 4;', 'print false'],
    ['print 1 == 1;', 'print true'],
    ['print 1 != 1;', 'print false'],
    ['print true == false;', 'print false'],
    ['print !true;', 'print false']
  ])('folds %j to %j', (source, expected) => {
    expect(foldedText(source)).toContain(expected)
  })
})

describe('what it refuses to fold', () => {
  /*
   * The interesting half. A folder that folds too much is worse than one that
   * folds too little, because the damage is silent and shows up as a program
   * that behaves differently depending on whether a value was written as a
   * literal.
   */

  it('leaves division by zero for the VM to decide', () => {
    const text = foldedText('print 1 / 0;')
    // The instruction survives. Part 9 chooses what `1 / 0` does, once, for
    // both `1 / 0` and `1 / x` where `x` happens to be zero.
    expect(text).toMatch(/= \/ 1, 0/)
    expect(text).not.toContain('print Infinity')
  })

  it('leaves modulo by zero alone for the same reason', () => {
    expect(foldedText('print 1 % 0;')).toMatch(/= % 1, 0/)
  })

  it('leaves an operation on a value it does not know', () => {
    // `a + 1` inside `f` cannot fold: `a` is a parameter, unknown until a call.
    const f = foldedModule('fn f(a: int) -> int { return a + 1; }\nprint f(2);').functions.find(
      (fn) => fn.name === 'f'
    ) as IrFunction
    expect(printFunction(f)).toMatch(/= \+ /)
  })

  it('does not turn a constant branch into a jump', () => {
    /*
     * `branch true, then, else` could obviously become `jump then`. Doing it
     * here would strand the else block with no path from the entry, which the
     * verifier reports as `unreachable-block` — so the pipeline would refuse
     * the pass. Removing the orphan is dead-code elimination's job.
     */
    const text = foldedText('if 1 < 2 { print 1; } else { print 2; }')
    expect(text).toContain('branch true')
    expect(text).not.toMatch(/^\s*jump .*\n.*jump/m)
  })

  it('never folds a load, however obvious the stored value looks', () => {
    // A load reads memory a store may have changed. Turning loads into
    // constants is mem2reg's job and needs dominance to be safe.
    const text = foldedText('let x = 1; print x;')
    expect(text).toContain('load')
  })
})

describe('chains', () => {
  it('folds a chain that needs more than one round', () => {
    // `1 + 2` folds first; only then can `%1 + 3`. A single forward walk would
    // leave the second addition behind.
    expect(foldedText('print 1 + 2 + 3;')).toContain('print 6')
    expect(foldedText('print 1 + 2 + 3;')).not.toMatch(/= \+ /)
  })

  it('stops at the memory boundary, which is where mem2reg starts', () => {
    /*
     * `let a = 1 + 2; let b = a + 3;` folds only its first half. The `1 + 2`
     * becomes `store %1, 3`, and then the chain goes through memory:
     *
     *   %2 = load %1
     *   %3 = + %2, 3
     *
     * `%2` is a load, and this pass will not fold a load however obvious the
     * stored value looks — a store between the two could have changed it, and
     * proving otherwise needs dominance. So the addition survives, correctly,
     * until mem2reg turns that traffic into values. Asserting it here means the
     * mem2reg commit has a test that already knows what it is supposed to
     * improve.
     */
    const text = foldedText('let a = 1 + 2; let b = a + 3; print b;')
    expect(text).toContain('store %1, 3')
    expect(text).toMatch(/%3 = \+ %2, 3/)
  })

  it('reports the rounds it needed', () => {
    const report = runPipeline(moduleFor('print 1 + 2 + 3 + 4;'), [constantFolding])
    expect(report.outcomes[0]?.notes[0]).toMatch(/^folded \d+ instructions? over \d+ rounds$/)
  })

  it('writes no note and reports no change when there is nothing to fold', () => {
    const report = runPipeline(moduleFor('fn f(a: int) -> int { return a; }\nf(1);'), [
      constantFolding
    ])
    const forF = report.outcomes.find((outcome) => outcome.fn === 'f')
    expect(forF?.changed).toBe(false)
    expect(forF?.notes).toEqual([])
  })
})

describe('the result stays well-formed', () => {
  const PROGRAMS = [
    'print 1 + 2;',
    'let x = 1 + 2; print x + 3;',
    'if 1 < 2 { print 1; } else { print 2; }',
    'let i = 0; while i < 3 { print i; i = i + 1; }',
    'fn add(a: int, b: int) -> int { return a + b; }\nprint add(1 + 1, 2 * 2);',
    'fn f() -> bool { return !false; }\nprint f();'
  ]

  it.each(PROGRAMS)('verifies clean after folding %j', (source) => {
    // `runPipeline` already refuses a pass that breaks the IR, so this asserts
    // the pipeline did not silently roll back as well as that the IR is sound.
    const report = runPipeline(moduleFor(source), [constantFolding])
    expect(report.failure).toBeNull()
    expect(verifyModule(report.module)).toEqual([])
  })

  it('substitutes into every operand position, not only the easy ones', () => {
    // Terminators, calls, prints and stores all read operands. A substitution
    // that missed one would leave a use of a deleted value, which the verifier
    // reports as `undefined-value` — so this passing through the pipeline is
    // the real assertion.
    const source = [
      'fn g(a: int, b: int) -> int { return a + b; }',
      'let x = 2 * 3;',
      'if 1 < 2 { print g(1 + 1, x); } else { print -7 + 1; }'
    ].join('\n')

    const report = runPipeline(moduleFor(source), [constantFolding])
    expect(report.failure, report.failure?.message).toBeNull()
    expect(verifyModule(report.module)).toEqual([])
  })
})

describe('golden IR', () => {
  it('folds this function to exactly this', () => {
    /*
     * One golden case rather than many. Goldens are good at catching a change
     * nobody meant and bad at explaining what broke, so the rest of this file
     * asserts behaviour and this asserts shape.
     */
    expect(foldedText('print 2 * 3 + 4;')).toBe(
      ['fn <main>() -> unit {', 'entry.0:', '  print 10', '  ret', '}'].join('\n')
    )
  })
})
