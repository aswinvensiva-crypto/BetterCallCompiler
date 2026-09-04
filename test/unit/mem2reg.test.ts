import { describe, expect, it } from 'vitest'
import { parseSource } from '../../src/lang/parser'
import { resolve } from '../../src/lang/symbols'
import { typeCheck } from '../../src/lang/type-check'
import { lower } from '../../src/lang/lower'
import { printFunction, type IrFunction, type Module } from '../../src/lang/ir'
import { runPipeline, type PipelineReport } from '../../src/lang/pass-manager'
import {
  constantFolding,
  deadCodeElimination,
  mem2reg,
  OPTIMISATION_PIPELINE
} from '../../src/lang/passes'
import { verifyModule } from '../../src/lang/verify'

/**
 * mem2reg, and the pipeline it completes.
 *
 * The transformation itself is `toSsa`, tested since Part 6 in `ssa.test.ts`.
 * What is new here is everything around it — that it is a pass, that its output
 * is verified in the pipeline rather than only in isolation, that it reports
 * what it did, and above all that its ORDER earns its place. The last of those
 * is the only claim a reader could not check by inspection, so it gets a test
 * that fails when the order is wrong.
 */

function moduleFor(source: string): Module {
  const { program, diagnostics } = parseSource(source)
  expect(diagnostics, `parse errors in ${JSON.stringify(source)}`).toEqual([])
  const resolution = resolve(program)
  return lower(program, resolution, typeCheck(program, resolution))
}

function run(module: Module, passes = OPTIMISATION_PIPELINE): PipelineReport {
  const report = runPipeline(module, passes)
  expect(report.failure, report.failure?.message).toBeNull()
  return report
}

function textOf(report: PipelineReport, name = '<main>'): string {
  const fn = report.module.functions.find((candidate) => candidate.name === name)
  expect(fn, `no function named ${name}`).toBeDefined()
  return printFunction(fn as IrFunction)
}

function notesFor(report: PipelineReport, pass: string, name = '<main>'): readonly string[] {
  return report.outcomes.find((o) => o.pass === pass && o.fn === name)?.notes ?? []
}

describe('promotion', () => {
  it('takes a variable out of memory entirely', () => {
    const before = printFunction(moduleFor('let x = 1; print x;').functions[0] as IrFunction)
    expect(before).toContain('alloca x')
    expect(before).toContain('load')

    const text = textOf(run(moduleFor('let x = 1; print x;'), [mem2reg]))
    expect(text).not.toContain('alloca')
    expect(text).not.toContain('load')
    expect(text).not.toContain('store')
  })

  it('inserts a phi where a loop carries a variable round', () => {
    const text = textOf(run(moduleFor('let i = 0;\nwhile i < 3 { i = i + 1; }\nprint i;'), [mem2reg]))
    // Zero on the way in, the incremented value on the way round. This is the
    // node the whole of Part 6 existed to be able to place.
    expect(text).toContain('phi i [entry.0, 0], [while.body.2, %4]')
  })

  it('reports what it moved', () => {
    const report = run(moduleFor('let i = 0;\nwhile i < 3 { i = i + 1; }\nprint i;'), [mem2reg])
    expect(notesFor(report, 'mem2reg').join('; ')).toBe(
      'promoted 1 variable; removed 3 loads; inserted 1 phi'
    )
  })

  it('does nothing the second time', () => {
    // There is no second set of allocas to promote. A pass that was not
    // idempotent would keep reporting work and keep changing the content hash,
    // which is what Part 12's memo cutoff will key on.
    const report = run(moduleFor('let x = 1; print x;'), [mem2reg, mem2reg])
    const [first, second] = report.outcomes
    expect(first?.changed).toBe(true)
    expect(second?.changed).toBe(false)
    expect(second?.notes).toEqual([])
  })

  it('promotes a parameter, not only a let', () => {
    const report = run(moduleFor('fn f(a: int) -> int { return a + 1; }\nf(1);'), [mem2reg])
    expect(textOf(report, 'f')).not.toContain('alloca')
  })
})

describe('the order the pipeline runs in', () => {
  it('finishes the fold that const-fold alone could not', () => {
    /*
     * The payoff, and the test `const-fold.test.ts` said would arrive.
     *
     * `let a = 1 + 2; let b = a + 3; print b;` folds only its first half
     * without promotion: the chain runs through memory, `%2 = load %1` is
     * opaque, and folding correctly refuses it. With mem2reg in front the whole
     * thing collapses to a single constant.
     */
    const foldedOnly = textOf(run(moduleFor('let a = 1 + 2; let b = a + 3; print b;'), [
      constantFolding
    ]))
    expect(foldedOnly).toMatch(/%3 = \+ %2, 3/)

    const promotedFirst = textOf(run(moduleFor('let a = 1 + 2; let b = a + 3; print b;')))
    expect(promotedFirst).toContain('print 6')
    expect(promotedFirst).not.toMatch(/= \+ /)
  })

  it('is the order that matters, not merely running all four', () => {
    /*
     * The same four passes with mem2reg LAST leave the addition behind, because
     * by the time the variables are promoted there is no folding pass after it.
     * This is what makes `OPTIMISATION_PIPELINE`'s ordering a decision rather
     * than a list.
     */
    const wrongOrder = textOf(
      run(moduleFor('let a = 1 + 2; let b = a + 3; print b;'), [
        constantFolding,
        deadCodeElimination,
        mem2reg
      ])
    )

    expect(wrongOrder).toMatch(/= \+ /)
    expect(wrongOrder).not.toContain('print 6')
  })

  it('lets DCE clean up the phis minimal SSA leaves behind', () => {
    /*
     * `ssa.ts` places phis by dominance frontier without asking whether the
     * variable is live there — "minimal" in Cytron's sense. Computing liveness
     * there would avoid them; letting DCE delete them costs nothing and keeps
     * that file about one idea. So mem2reg may insert a phi that DCE then
     * removes, and the pipeline as a whole is what makes that a good trade.
     */
    const report = run(moduleFor('let x = 0;\nif 1 < 2 { x = 1; } else { x = 2; }\nprint x;'))
    const text = textOf(report)

    expect(notesFor(report, 'mem2reg').join('; ')).toContain('inserted 1 phi')
    // Folding makes the branch constant, DCE strands and removes the else
    // block, and copy-prop retires the phi that is left with one arm.
    expect(text).not.toContain('phi')
    expect(text).toContain('print 1')
  })
})

describe('the whole pipeline stays well-formed', () => {
  const PROGRAMS = [
    'print 1;',
    'let x = 1; print x;',
    'let a = 1 + 2; let b = a + 3; print b;',
    'let x = 0;\nif 1 < 2 { x = 1; } else { x = 2; }\nprint x;',
    'let x = 0;\nif 1 > 2 { x = 1; } else { x = 2; }\nprint x;',
    'let i = 0;\nwhile i < 3 { i = i + 1; }\nprint i;',
    'let i = 0;\nwhile i < 3 { print i; i = i + 1; }',
    'while false { print 1; }',
    'fn f(a: int) -> int { if a > 0 { return a; } else { return -a; } }\nprint f(-3);',
    'fn add(a: int, b: int) -> int { return a + b; }\nprint add(1 + 1, 2 * 2);',
    'fn f(c: bool) -> int { let x = 0; if c { x = 5; } else { x = 5; } return x; }\nprint f(true);',
    'fn nothing() { }\nnothing();',
    'fn loops() -> int { while true { } }'
  ]

  it.each(PROGRAMS)('runs every pass clean on %j', (source) => {
    // The pipeline refuses any pass that breaks the IR, so a null failure means
    // all four verified. Asserting `verifyModule` as well catches the case
    // where the pipeline rolled back and handed us valid but unoptimised IR.
    const report = runPipeline(moduleFor(source), OPTIMISATION_PIPELINE)
    expect(report.failure, report.failure?.message).toBeNull()
    expect(verifyModule(report.module)).toEqual([])
  })

  it('leaves no memory traffic in any of them', () => {
    for (const source of PROGRAMS) {
      const report = run(moduleFor(source))
      for (const fn of report.module.functions) {
        expect(printFunction(fn), `alloca survived in ${source}`).not.toContain('alloca')
      }
    }
  })
})

describe('golden IR', () => {
  it('optimises a counted loop to exactly this', () => {
    expect(textOf(run(moduleFor('let i = 0;\nwhile i < 3 { i = i + 1; }\nprint i;')))).toBe(
      [
        'fn <main>() -> unit {',
        'entry.0:',
        '  jump while.head.1',
        'while.head.1:',
        '  %6 = phi i [entry.0, 0], [while.body.2, %4]',
        '  %2 = < %6, 3',
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

  it('reduces a chain through two variables to one constant', () => {
    expect(textOf(run(moduleFor('let a = 1 + 2; let b = a + 3; print b;')))).toBe(
      ['fn <main>() -> unit {', 'entry.0:', '  print 6', '  ret', '}'].join('\n')
    )
  })
})
