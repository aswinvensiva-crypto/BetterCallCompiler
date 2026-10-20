import { describe, expect, it } from 'vitest'
import { parseSource } from '../../src/lang/parser'
import { resolve } from '../../src/lang/symbols'
import { typeCheck } from '../../src/lang/type-check'
import { lower } from '../../src/lang/lower'
import { toSsa } from '../../src/lang/ssa'
import { constant, printFunction, value, type IrFunction, type Module } from '../../src/lang/ir'
import { runPipeline, type PipelineReport } from '../../src/lang/pass-manager'
import { constantFolding } from '../../src/lang/passes/const-fold'
import { deadCodeElimination, forTesting } from '../../src/lang/passes/dce'
import { verifyModule } from '../../src/lang/verify'
import type { Span } from '../../src/lang/token'

/**
 * Dead code elimination.
 *
 * Like the folding tests, everything runs through `runPipeline`, so the
 * verifier checks each output. That matters more here than it did there: this
 * pass removes BLOCKS, and a removed block takes its edges with it — so a phi
 * in any block it reached now has the wrong number of arguments. The verifier
 * calls that `phi-arity-mismatch`, and it is the failure this pass is most
 * likely to cause and least likely to notice on its own.
 */

const SPAN: Span = {
  offset: 0,
  length: 0,
  startLine: 1,
  startColumn: 1,
  endLine: 1,
  endColumn: 1
}

function moduleFor(source: string): Module {
  const { program, diagnostics } = parseSource(source)
  expect(diagnostics, `parse errors in ${JSON.stringify(source)}`).toEqual([])
  const resolution = resolve(program)
  return lower(program, resolution, typeCheck(program, resolution))
}

/** In SSA form, which is where phis exist to be pruned. */
function ssaModuleFor(source: string): Module {
  return { functions: moduleFor(source).functions.map(toSsa) }
}

function run(module: Module, passes = [deadCodeElimination]): PipelineReport {
  const report = runPipeline(module, passes)
  expect(report.failure, report.failure?.message).toBeNull()
  return report
}

/**
 * One function's IR as text, the top level by default.
 *
 * By NAME, not by position: a source that declares `fn f` before its first
 * statement puts `f` at index 0, and a positional helper would quietly assert
 * against the wrong function.
 */
function textOf(report: PipelineReport, name = '<main>'): string {
  const fn = report.module.functions.find((candidate) => candidate.name === name)
  expect(fn, `no function named ${name}`).toBeDefined()
  return printFunction(fn as IrFunction)
}

function notesFor(report: PipelineReport, pass: string): readonly string[] {
  return report.outcomes.find((outcome) => outcome.pass === pass && outcome.fn === '<main>')?.notes ?? []
}

describe('unreachable blocks', () => {
  it('turns a constant branch into a jump and drops the orphan', () => {
    const report = run(moduleFor('if 1 < 2 { print 1; } else { print 2; }'), [
      constantFolding,
      deadCodeElimination
    ])
    const text = textOf(report)

    expect(text).toContain('jump then.1')
    expect(text).not.toContain('branch')
    // The else block is gone, and with it the print nobody could reach.
    expect(text).not.toContain('print 2')
    expect(text).toContain('print 1')
  })

  it('is the pass that owns the branch rewrite const-fold refused', () => {
    /*
     * `const-fold` leaves `branch true, a, b` alone because turning it into
     * `jump a` strands `b`, which the verifier reports as `unreachable-block`.
     * It is legal here only because this pass removes the orphan in the same
     * round. Running folding ALONE must therefore still show the branch.
     */
    const folded = run(moduleFor('if 1 < 2 { print 1; } else { print 2; }'), [constantFolding])
    expect(textOf(folded)).toContain('branch true')
  })

  it('empties a loop whose condition is always false', () => {
    const text = textOf(run(moduleFor('while false { print 1; }')))
    expect(text).not.toContain('print 1')
    expect(text).not.toContain('branch')
  })

  it('leaves a loop whose condition it cannot decide', () => {
    const report = run(moduleFor('let i = 0; while i < 3 { print i; i = i + 1; }'))
    expect(textOf(report)).toContain('branch')
    expect(report.outcomes[0]?.changed).toBe(false)
  })
})

describe('dead instructions', () => {
  it('removes a computation nothing reads', () => {
    // `%1 = + %0, 1` with nothing reading `%1`.
    const fn: IrFunction = {
      name: 'f',
      params: [],
      returnType: { kind: 'unit' },
      entry: 0,
      span: SPAN,
      blocks: [
        {
          id: 0,
          label: 'entry',
          instructions: [
            { op: 'binary', result: 0, operator: '+', left: constant(1), right: constant(1), span: SPAN },
            { op: 'binary', result: 1, operator: '+', left: value(0), right: constant(1), span: SPAN }
          ],
          terminator: { op: 'return', value: null, span: SPAN }
        }
      ]
    }

    const report = run({ functions: [fn] })
    expect(printFunction(report.module.functions[0] as IrFunction)).not.toMatch(/= \+ /)
  })

  it('keeps a computation something reads, and everything it depends on', () => {
    // Liveness is transitive: `print %1` keeps `%1`, which keeps `%0`. A single
    // walk in the wrong order would delete `%0` and leave `%1` reading nothing.
    const fn: IrFunction = {
      name: 'f',
      params: [],
      returnType: { kind: 'unit' },
      entry: 0,
      span: SPAN,
      blocks: [
        {
          id: 0,
          label: 'entry',
          instructions: [
            { op: 'binary', result: 0, operator: '+', left: constant(1), right: constant(1), span: SPAN },
            { op: 'binary', result: 1, operator: '*', left: value(0), right: constant(2), span: SPAN },
            { op: 'print', value: value(1), span: SPAN }
          ],
          terminator: { op: 'return', value: null, span: SPAN }
        }
      ]
    }

    const report = run({ functions: [fn] })
    const text = printFunction(report.module.functions[0] as IrFunction)
    expect(text).toContain('%0 = + 1, 1')
    expect(text).toContain('%1 = * %0, 2')
  })

  it('keeps a value a terminator reads', () => {
    const report = run(moduleFor('fn f(a: int) -> int { return a + 1; }\nf(1);'))
    const f = report.module.functions.find((fn) => fn.name === 'f') as IrFunction
    expect(printFunction(f)).toMatch(/= \+ /)
  })
})

describe('what it will not remove', () => {
  it('never removes a print', () => {
    // The program's only output. Nothing reads it, and it still stays.
    expect(textOf(run(moduleFor('print 1;')))).toContain('print 1')
  })

  it('never removes a call, even one whose result is unused', () => {
    // BCC has no purity analysis, and a call may print inside.
    const report = run(moduleFor('fn f() -> int { print 1; return 2; }\nf();'))
    expect(textOf(report)).toContain('call f')
  })

  it('keeps a store, and says why in the pass rather than pretending', () => {
    /*
     * A store to a slot never loaded again is genuinely dead, but proving
     * "never loaded again" needs the dominance walk mem2reg is about to do. So
     * `let x = 1 + 2; print 9;` keeps its alloca and store. This is a stated
     * limitation, and the mem2reg commit is what removes the traffic entirely.
     */
    const report = run(moduleFor('let x = 1 + 2; print 9;'), [
      constantFolding,
      deadCodeElimination
    ])
    expect(textOf(report)).toContain('store %1, 3')
  })

  it('leaves a branch whose arms are the same block', () => {
    /*
     * `branch %c, join, join` is two edges to one block, and a phi in `join`
     * has one argument per EDGE. Collapsing it to `jump join` would leave every
     * phi there with an argument too many — `ir.ts` keeps duplicate
     * predecessors for exactly this reason.
     */
    const same = forTesting.simplify({
      op: 'branch',
      condition: constant(true),
      ifTrue: 3,
      ifFalse: 3,
      span: SPAN
    })
    expect(same).toBeNull()
  })

  it('leaves a branch on a value it cannot decide', () => {
    expect(
      forTesting.simplify({
        op: 'branch',
        condition: value(7),
        ifTrue: 1,
        ifFalse: 2,
        span: SPAN
      })
    ).toBeNull()
  })
})

describe('phi arguments follow the edges', () => {
  it('prunes the arm of a predecessor it removed', () => {
    const source = 'let x = 0;\nif 1 < 2 { x = 1; } else { x = 2; }\nprint x;'
    const before = printFunction(ssaModuleFor(source).functions[0] as IrFunction)
    expect(before).toContain('phi x [then.1, 1], [else.2, 2]')

    const report = run(ssaModuleFor(source), [constantFolding, deadCodeElimination])
    const after = textOf(report)

    // One predecessor left, so one argument. A pass that removed the block and
    // left the phi alone would produce `phi-arity-mismatch` and the pipeline
    // would have rolled it back — which is what `run` asserts.
    expect(after).toContain('phi x [then.1, 1]')
    expect(after).not.toContain('else.2')
  })

  it('keeps the arm that survives, not merely the first one', () => {
    // The `else` arm is the one that survives here, so a pass that always kept
    // the first argument would print `1` where the program prints `2`.
    const source = 'let x = 0;\nif 1 > 2 { x = 1; } else { x = 2; }\nprint x;'
    const after = textOf(run(ssaModuleFor(source), [constantFolding, deadCodeElimination]))
    expect(after).toContain('phi x [else.2, 2]')
    expect(after).not.toContain('then.1')
  })
})

describe('rounds and notes', () => {
  it('reports what it did, by kind', () => {
    const report = run(moduleFor('if 1 < 2 { print 1; } else { print 2; }'), [
      constantFolding,
      deadCodeElimination
    ])
    const notes = notesFor(report, 'dce')
    expect(notes.join('; ')).toContain('simplified 1 constant branch')
    expect(notes.join('; ')).toContain('removed 1 unreachable block')
  })

  it('writes no note and reports no change when there is nothing dead', () => {
    const report = run(moduleFor('print 1;'))
    expect(report.outcomes[0]?.changed).toBe(false)
    expect(report.outcomes[0]?.notes).toEqual([])
  })
})

describe('the result stays well-formed', () => {
  const PROGRAMS = [
    'print 1;',
    'if 1 < 2 { print 1; } else { print 2; }',
    'if 1 > 2 { print 1; } else { print 2; }',
    'while false { print 1; }',
    'let i = 0; while i < 3 { print i; i = i + 1; }',
    'let x = 0;\nif 1 < 2 { x = 1; } else { x = 2; }\nprint x;',
    'fn f(a: int) -> int { if a > 0 { return a; } else { return -a; } }\nprint f(-3);',
    'fn nothing() { }\nnothing();'
  ]

  it.each(PROGRAMS)('verifies clean in SSA form after fold + dce: %j', (source) => {
    const report = runPipeline(ssaModuleFor(source), [constantFolding, deadCodeElimination])
    expect(report.failure, report.failure?.message).toBeNull()
    expect(verifyModule(report.module)).toEqual([])
  })

  it.each(PROGRAMS)('verifies clean without SSA too: %j', (source) => {
    const report = runPipeline(moduleFor(source), [constantFolding, deadCodeElimination])
    expect(report.failure, report.failure?.message).toBeNull()
    expect(verifyModule(report.module)).toEqual([])
  })
})

describe('golden IR', () => {
  it('reduces a constant conditional to exactly this', () => {
    const report = run(moduleFor('if 1 < 2 { print 1; } else { print 2; }'), [
      constantFolding,
      deadCodeElimination
    ])

    expect(textOf(report)).toBe(
      [
        'fn <main>() -> unit {',
        'entry.0:',
        '  jump then.1',
        'then.1:',
        '  print 1',
        '  jump join.3',
        'join.3:',
        '  ret',
        '}'
      ].join('\n')
    )
  })
})
