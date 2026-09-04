import { describe, expect, it } from 'vitest'
import { parseSource } from '../../src/lang/parser'
import { resolve as resolveSymbols } from '../../src/lang/symbols'
import { typeCheck } from '../../src/lang/type-check'
import { lower } from '../../src/lang/lower'
import { toSsa } from '../../src/lang/ssa'
import {
  constant,
  printFunction,
  value,
  type Block,
  type IrFunction,
  type Module,
  type Phi
} from '../../src/lang/ir'
import { runPipeline, type PipelineReport } from '../../src/lang/pass-manager'
import { constantFolding } from '../../src/lang/passes/const-fold'
import { deadCodeElimination } from '../../src/lang/passes/dce'
import { copyPropagation, forTesting } from '../../src/lang/passes/copy-prop'
import { verifyModule } from '../../src/lang/verify'
import type { Span } from '../../src/lang/token'

/**
 * Copy propagation.
 *
 * The pass with the most ways to be subtly wrong, because "these two arms are
 * the same value" is a judgement and every wrong version of it is silent. Two
 * constants that are equal but not identical, a phi that names itself, a chain
 * of phis that each name the next — each of those has a plausible
 * implementation that gets a different answer, so each gets a case.
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
  const resolution = resolveSymbols(program)
  return lower(program, resolution, typeCheck(program, resolution))
}

function ssaModuleFor(source: string): Module {
  return { functions: moduleFor(source).functions.map(toSsa) }
}

function run(module: Module, passes = [copyPropagation]): PipelineReport {
  const report = runPipeline(module, passes)
  expect(report.failure, report.failure?.message).toBeNull()
  return report
}

function textOf(report: PipelineReport, name = '<main>'): string {
  const fn = report.module.functions.find((candidate) => candidate.name === name)
  expect(fn, `no function named ${name}`).toBeDefined()
  return printFunction(fn as IrFunction)
}

const phi = (result: number, incoming: Phi['incoming']): Phi => ({
  op: 'phi',
  result,
  name: 'x',
  incoming,
  span: SPAN
})

describe('what counts as a copy', () => {
  it('resolves a phi with one arm', () => {
    // The shape DCE leaves behind when it deletes a predecessor, which is why
    // these two passes sit next to each other in this order.
    expect(forTesting.trivialTarget(phi(3, [{ from: 1, value: value(2) }]))).toEqual(value(2))
  })

  it('resolves a phi whose arms are all the same value', () => {
    expect(
      forTesting.trivialTarget(
        phi(3, [
          { from: 1, value: value(2) },
          { from: 2, value: value(2) }
        ])
      )
    ).toEqual(value(2))
  })

  it('compares constants by value, not by object identity', () => {
    /*
     * `constant(5)` twice makes two different objects holding the same number.
     * An implementation comparing with `===` or by `Set` of objects would call
     * this a real choice and leave every phi mem2reg builds over a constant.
     */
    const arms = phi(3, [
      { from: 1, value: constant(5) },
      { from: 2, value: constant(5) }
    ])
    expect(arms.incoming[0]?.value).not.toBe(arms.incoming[1]?.value)
    expect(forTesting.trivialTarget(arms)).toEqual(constant(5))
  })

  it('does not confuse the constant 5 with the value %5', () => {
    expect(
      forTesting.trivialTarget(
        phi(3, [
          { from: 1, value: constant(5) },
          { from: 2, value: value(5) }
        ])
      )
    ).toBeNull()
  })

  it('leaves a phi that is a real choice', () => {
    expect(
      forTesting.trivialTarget(
        phi(3, [
          { from: 1, value: constant(0) },
          { from: 2, value: value(4) }
        ])
      )
    ).toBeNull()
  })
})

describe('a phi that names itself', () => {
  it('ignores the self-reference when deciding', () => {
    /*
     * `%3 = phi i [entry, %1], [loop, %3]` is the shape of a loop-carried
     * variable that is never reassigned. The self-arm says "whatever this phi
     * already is", which constrains nothing — excluding it is what lets `%3`
     * resolve to `%1` rather than being left alone forever. It is the rule
     * Braun's SSA construction states, and without it this pass cannot
     * simplify a loop at all.
     */
    expect(
      forTesting.trivialTarget(
        phi(3, [
          { from: 0, value: value(1) },
          { from: 1, value: value(3) }
        ])
      )
    ).toEqual(value(1))
  })

  it('leaves a phi whose arms are all self-references', () => {
    // It names nothing, and inventing a value here would be worse than leaving
    // it for the verifier.
    expect(forTesting.trivialTarget(phi(3, [{ from: 1, value: value(3) }]))).toBeNull()
  })

  it('propagates one through the real pipeline', () => {
    // Hand-built, because `toSsa` is careful enough not to emit a
    // self-referential phi for any program this front end can express.
    const blocks: Block[] = [
      {
        id: 0,
        label: 'entry',
        instructions: [
          { op: 'binary', result: 1, operator: '+', left: constant(1), right: constant(1), span: SPAN }
        ],
        terminator: { op: 'jump', target: 1, span: SPAN }
      },
      {
        id: 1,
        label: 'loop',
        instructions: [
          phi(3, [
            { from: 0, value: value(1) },
            { from: 1, value: value(3) }
          ]),
          { op: 'print', value: value(3), span: SPAN }
        ],
        terminator: { op: 'jump', target: 1, span: SPAN }
      }
    ]

    const fn: IrFunction = {
      name: 'f',
      params: [],
      returnType: { kind: 'unit' },
      entry: 0,
      span: SPAN,
      blocks
    }

    const report = run({ functions: [fn] })
    const text = textOf(report, 'f')

    expect(text).not.toContain('phi')
    expect(text).toContain('print %1')
  })
})

describe('through the front end', () => {
  it('removes the phi DCE reduced to one arm', () => {
    const source = 'let x = 0;\nif 1 < 2 { x = 1; } else { x = 2; }\nprint x;'
    expect(printFunction(ssaModuleFor(source).functions[0] as IrFunction)).toContain('phi')

    const report = run(ssaModuleFor(source), [
      constantFolding,
      deadCodeElimination,
      copyPropagation
    ])
    const text = textOf(report)

    expect(text).not.toContain('phi')
    // The surviving arm's value reaches the print directly.
    expect(text).toContain('print 1')
  })

  it('removes a phi whose arms agree even when the branch does not fold', () => {
    // `c` is a parameter, so nothing folds and no block is removed — the phi is
    // trivial on its own merits rather than because DCE reduced it.
    const source =
      'fn f(c: bool) -> int { let x = 0; if c { x = 5; } else { x = 5; } return x; }\nprint f(true);'
    const report = run(ssaModuleFor(source))
    const text = textOf(report, 'f')

    expect(text).toContain('branch %0')
    expect(text).not.toContain('phi')
    expect(text).toContain('ret 5')
  })

  it('leaves the loop phi that is a genuine choice', () => {
    // `%6 = phi i [entry.0, 0], [while.body.2, %4]` — zero on the way in and
    // the incremented value on the way round. Removing it would be wrong.
    const report = run(ssaModuleFor('let i = 0;\nwhile i < 3 { i = i + 1; }\nprint i;'))
    expect(textOf(report)).toContain('phi i')
    expect(report.outcomes[0]?.changed).toBe(false)
    expect(report.outcomes[0]?.notes).toEqual([])
  })
})

describe('chains', () => {
  it('resolves a chain of trivial phis in one round', () => {
    /*
     * `%4 → %3 → %2`. `resolve` follows the substitution map to its end, so all
     * three collapse together; a version that substituted one step per round
     * would need three and would over-report the work in its note.
     */
    const blocks: Block[] = [
      {
        id: 0,
        label: 'entry',
        instructions: [
          { op: 'binary', result: 2, operator: '+', left: constant(1), right: constant(1), span: SPAN }
        ],
        terminator: { op: 'jump', target: 1, span: SPAN }
      },
      {
        id: 1,
        label: 'a',
        instructions: [phi(3, [{ from: 0, value: value(2) }])],
        terminator: { op: 'jump', target: 2, span: SPAN }
      },
      {
        id: 2,
        label: 'b',
        instructions: [
          phi(4, [{ from: 1, value: value(3) }]),
          { op: 'print', value: value(4), span: SPAN }
        ],
        terminator: { op: 'return', value: null, span: SPAN }
      }
    ]

    const fn: IrFunction = {
      name: 'f',
      params: [],
      returnType: { kind: 'unit' },
      entry: 0,
      span: SPAN,
      blocks
    }

    const report = run({ functions: [fn] })
    expect(textOf(report, 'f')).toContain('print %2')
    expect(report.outcomes[0]?.notes).toEqual(['propagated 2 trivial phis'])
  })
})

describe('the result stays well-formed', () => {
  const PROGRAMS = [
    'print 1;',
    'let x = 0;\nif 1 < 2 { x = 1; } else { x = 2; }\nprint x;',
    'let x = 0;\nif 1 > 2 { x = 1; } else { x = 2; }\nprint x;',
    'let i = 0;\nwhile i < 3 { i = i + 1; }\nprint i;',
    'fn f(c: bool) -> int { let x = 0; if c { x = 5; } else { x = 5; } return x; }\nprint f(true);',
    'fn g(a: int) -> int { if a > 0 { return a; } else { return -a; } }\nprint g(-3);'
  ]

  it.each(PROGRAMS)('verifies clean after the whole pipeline: %j', (source) => {
    const report = runPipeline(ssaModuleFor(source), [
      constantFolding,
      deadCodeElimination,
      copyPropagation
    ])
    expect(report.failure, report.failure?.message).toBeNull()
    expect(verifyModule(report.module)).toEqual([])
  })
})

describe('golden IR', () => {
  it('reduces a constant conditional over a variable to exactly this', () => {
    const report = run(ssaModuleFor('let x = 0;\nif 1 < 2 { x = 1; } else { x = 2; }\nprint x;'), [
      constantFolding,
      deadCodeElimination,
      copyPropagation
    ])

    expect(textOf(report)).toBe(
      [
        'fn <main>() -> unit {',
        'entry.0:',
        '  jump then.1',
        'then.1:',
        '  jump join.3',
        'join.3:',
        '  print 1',
        '  ret',
        '}'
      ].join('\n')
    )
  })
})
