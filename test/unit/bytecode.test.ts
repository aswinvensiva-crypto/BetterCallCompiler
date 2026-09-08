import { describe, expect, it } from 'vitest'
import { parseSource } from '../../src/lang/parser'
import { resolve } from '../../src/lang/symbols'
import { typeCheck } from '../../src/lang/type-check'
import { lower, TOP_LEVEL_FUNCTION } from '../../src/lang/lower'
import { runPipeline } from '../../src/lang/pass-manager'
import { OPTIMISATION_PIPELINE } from '../../src/lang/passes'
import { value, type Block, type IrFunction } from '../../src/lang/ir'
import {
  BytecodeError,
  compileFunction,
  compileModule,
  printFunctionCode,
  type CompiledFunction,
  type Program
} from '../../src/lang/bytecode'
import type { Span } from '../../src/lang/token'

/**
 * Bytecode.
 *
 * The stage where two things become real that were only descriptions before: a
 * phi, which nothing computes, and a span, which is about to be the only debug
 * information Part 10 has. Both get their own section, because both are the
 * kind of thing that is easy to emit almost-right.
 */

const SPAN: Span = {
  offset: 0,
  length: 0,
  startLine: 1,
  startColumn: 1,
  endLine: 1,
  endColumn: 1
}

function compile(source: string): Program {
  const { program, diagnostics } = parseSource(source)
  expect(diagnostics, `parse errors in ${JSON.stringify(source)}`).toEqual([])
  const resolution = resolve(program)
  const report = runPipeline(lower(program, resolution, typeCheck(program, resolution)), OPTIMISATION_PIPELINE)
  expect(report.failure, report.failure?.message).toBeNull()
  return compileModule(report.module, TOP_LEVEL_FUNCTION)
}

const main = (program: Program): CompiledFunction =>
  program.functions.get(TOP_LEVEL_FUNCTION) as CompiledFunction

const listing = (fn: CompiledFunction): string[] =>
  printFunctionCode(fn)
    .split('\n')
    .slice(1, -1)
    .map((line) => line.trim().replace(/^\d+\s+/, ''))

describe('the shape of the output', () => {
  it('compiles a constant print to three instructions', () => {
    // Part 8 already folded `1 + 2`, so the arithmetic is gone before this
    // stage sees it — which is the pipeline working, not the compiler cheating.
    expect(listing(main(compile('print 1 + 2;')))).toEqual(['const 3', 'print', 'returnUnit'])
  })

  it('gives every SSA value a slot, and parameters the first ones', () => {
    /*
     * Order is load-bearing: the VM stores incoming arguments into slots
     * 0..n-1 without consulting the map, so a parameter landing anywhere else
     * would read another value's slot.
     */
    const program = compile('fn add(a: int, b: int) -> int { return a + b; }\nprint add(2, 3);')
    const add = program.functions.get('add') as CompiledFunction

    expect(add.arity).toBe(2)
    expect(listing(add).slice(0, 3)).toEqual(['load $0', 'load $1', 'binary +'])
  })

  it('drops the result of a call nobody named', () => {
    // Every call leaves a value; not popping it would grow the stack once per
    // call and leave the function unbalanced.
    const program = compile('fn f() { print 1; }\nf();')
    expect(listing(main(program))).toContain('pop')
  })

  it('keeps the result of a call that is used', () => {
    const program = compile('fn f() -> int { return 2; }\nprint f();')
    expect(listing(main(program))).not.toContain('pop')
  })

  it('marks whether a function returns a value', () => {
    const program = compile('fn f() -> int { return 2; }\nfn g() { print 1; }\ng();\nprint f();')
    expect((program.functions.get('f') as CompiledFunction).returnsValue).toBe(true)
    expect((program.functions.get('g') as CompiledFunction).returnsValue).toBe(false)
  })
})

describe('spans, which are the debug info', () => {
  /*
   * There is no line table beside this. `instruction.span` IS the mapping, and
   * Part 10's breakpoints are a lookup into it — so an instruction with a
   * meaningless span is a line that can never hold a breakpoint.
   */

  it('gives every instruction a span', () => {
    const program = compile('let i = 0;\nwhile i < 3 { print i; i = i + 1; }')

    for (const fn of program.functions.values()) {
      for (const instr of fn.code) {
        expect(instr.span, `${instr.op} has no span`).toBeDefined()
        expect(instr.span.startLine).toBeGreaterThan(0)
      }
    }
  })

  it('points the print at the line the print is on', () => {
    const program = compile('let x = 1;\nprint x;')
    const print = main(program).code.find((instr) => instr.op === 'print')
    expect(print?.span.startLine).toBe(2)
  })

  it('spreads instructions across the lines they came from', () => {
    // A compiler that stamped one span on everything would pass the two tests
    // above and make every breakpoint land on line 1.
    const program = compile('print 1;\nprint 2;\nprint 3;')
    const lines = main(program)
      .code.filter((instr) => instr.op === 'print')
      .map((instr) => instr.span.startLine)

    expect(lines).toEqual([1, 2, 3])
  })
})

describe('phis become stores in the predecessor', () => {
  /*
   * Nothing computes a phi — `ir.ts` calls it "a statement about the graph".
   * Making it real is this stage's job: before each jump, the predecessor
   * stores the value that block's phis expect.
   */

  it('emits no instruction for the phi itself', () => {
    const program = compile('let i = 0;\nwhile i < 3 { i = i + 1; }\nprint i;')
    // There is no `phi` opcode at all; the work moved to the edges.
    expect(listing(main(program)).some((line) => line.startsWith('phi'))).toBe(false)
  })

  it('stores the loop-carried value before jumping back', () => {
    const program = compile('let i = 0;\nwhile i < 3 { i = i + 1; }\nprint i;')
    const code = listing(main(program))

    // The last instruction before the back edge writes the phi's slot.
    const backEdge = code.lastIndexOf('jump 3')
    expect(backEdge).toBeGreaterThan(0)
    expect(code[backEdge - 1]).toMatch(/^store \$\d+$/)
  })

  it('gives each arm of a branch its own stores', () => {
    /*
     * The two arms owe DIFFERENT stores, so they cannot run before the branch
     * is decided. Each arm gets a stub that does its own and then jumps.
     */
    const program = compile('let x = 0;\nfn pick(c: bool) -> int { let y = 0; if c { y = 1; } else { y = 2; } return y; }\nprint pick(true);')
    const pick = program.functions.get('pick') as CompiledFunction
    const code = listing(pick)

    // Each arm contributes its own constant and its own store, and both stores
    // write the SAME slot — the phi's — from different paths. That is what
    // "the predecessor does the phi's work" means, and a compiler that hoisted
    // the store above the branch would show one store rather than two.
    expect(code.filter((line) => line === 'const 1')).toHaveLength(1)
    expect(code.filter((line) => line === 'const 2')).toHaveLength(1)

    const stores = code.filter((line) => line.startsWith('store $'))
    expect(stores).toHaveLength(2)
    expect(stores[0]).toBe(stores[1])

    // And each store is immediately followed by a jump to the join, so neither
    // arm falls through into the other's.
    const joins = code
      .map((line, index) => ({ line, index }))
      .filter((entry) => entry.line.startsWith('store $'))
      .map((entry) => code[entry.index + 1])
    expect(joins[0]).toMatch(/^jump \d+$/)
    expect(joins[0]).toBe(joins[1])
  })

  it('refuses phis that assign to each other rather than emitting a swap', () => {
    /*
     * `%1 = phi [a, %2]` and `%2 = phi [a, %1]` is a parallel assignment — a
     * swap — and sequential stores get it wrong. Breaking the cycle needs a
     * temporary. `toSsa` cannot produce this shape, so refusing is honest;
     * emitting the naive sequence would produce a program that runs and is
     * wrong, which is the worst outcome available.
     */
    const blocks: Block[] = [
      {
        id: 0,
        label: 'entry',
        instructions: [],
        terminator: { op: 'jump', target: 1, span: SPAN }
      },
      {
        id: 1,
        label: 'loop',
        instructions: [
          { op: 'phi', result: 1, name: 'a', incoming: [{ from: 0, value: value(2) }], span: SPAN },
          { op: 'phi', result: 2, name: 'b', incoming: [{ from: 0, value: value(1) }], span: SPAN }
        ],
        terminator: { op: 'return', value: null, span: SPAN }
      }
    ]

    const fn: IrFunction = {
      name: 'swap',
      params: [],
      returnType: { kind: 'unit' },
      entry: 0,
      span: SPAN,
      blocks
    }

    expect(() => compileFunction(fn)).toThrow(BytecodeError)
    expect(() => compileFunction(fn)).toThrow(/assign to each other/)
  })
})

describe('jump targets', () => {
  it('patches every jump to a real instruction index', () => {
    /*
     * The compiler emits jumps before it knows where they go and patches them
     * afterwards. A missed patch leaves -1, which the VM would read as a jump
     * off the end — so this checks the whole program rather than one case.
     */
    for (const source of [
      'print 1;',
      'let i = 0;\nwhile i < 3 { i = i + 1; }\nprint i;',
      'fn f(c: bool) -> int { if c { return 1; } else { return 2; } }\nprint f(true);'
    ]) {
      const program = compile(source)
      for (const fn of program.functions.values()) {
        for (const instr of fn.code) {
          if (instr.op !== 'jump' && instr.op !== 'jumpUnless') continue
          expect(instr.operand, `${source}: unpatched ${instr.op}`).toBeGreaterThanOrEqual(0)
          expect(instr.operand, `${source}: ${instr.op} past the end`).toBeLessThanOrEqual(fn.code.length)
        }
      }
    }
  })
})

describe('IR the VM cannot run', () => {
  /*
   * The VM has no memory model — mem2reg is supposed to have removed all of it.
   * A surviving alloca means the pipeline was skipped, and saying which
   * variable beats failing later with a bad slot index.
   */

  it('refuses an alloca, naming the variable and the pass', () => {
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
          instructions: [{ op: 'alloca', result: 0, name: 'x', type: { kind: 'int' }, span: SPAN }],
          terminator: { op: 'return', value: null, span: SPAN }
        }
      ]
    }

    expect(() => compileFunction(fn)).toThrow(/'x' is still in memory/)
    expect(() => compileFunction(fn)).toThrow(/mem2reg/)
  })

  it('refuses a use with no definition rather than loading slot -1', () => {
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
          instructions: [{ op: 'print', value: value(99), span: SPAN }],
          terminator: { op: 'return', value: null, span: SPAN }
        }
      ]
    }

    expect(() => compileFunction(fn)).toThrow(/%99 is used but never defined/)
  })

  it('carries the span on the error, so the editor can point at it', () => {
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
            { op: 'alloca', result: 0, name: 'x', type: { kind: 'int' }, span: { ...SPAN, startLine: 7 } }
          ],
          terminator: { op: 'return', value: null, span: SPAN }
        }
      ]
    }

    try {
      compileFunction(fn)
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as BytecodeError).span.startLine).toBe(7)
    }
  })
})

describe('golden listings', () => {
  it('compiles a counted loop to exactly this', () => {
    expect(listing(main(compile('let i = 0;\nwhile i < 3 { print i; i = i + 1; }')))).toEqual([
      'const 0',
      'store $0',
      'jump 3',
      'load $0',
      'const 3',
      'binary <',
      'store $1',
      'load $1',
      'jumpUnless 10',
      'jump 11',
      'jump 20',
      'load $0',
      'print',
      'load $0',
      'const 1',
      'binary +',
      'store $2',
      'load $2',
      'store $0',
      'jump 3',
      'returnUnit'
    ])
  })

  it('compiles a call to push, call, store', () => {
    const program = compile('fn add(a: int, b: int) -> int { return a + b; }\nprint add(2, 3);')
    expect(listing(main(program))).toEqual([
      'const 2',
      'const 3',
      'call add/2',
      'store $0',
      'load $0',
      'print',
      'returnUnit'
    ])
  })
})

describe('constants used by both halves', () => {
  it('keeps the entry name the lowering uses', () => {
    // The VM starts here; a mismatch would be "the program did nothing".
    expect(compile('print 1;').entry).toBe(TOP_LEVEL_FUNCTION)
    expect(compile('print 1;').functions.has(TOP_LEVEL_FUNCTION)).toBe(true)
  })

  it('compiles every operator the language has', () => {
    const source = [
      'print 7 + 1; print 7 - 1; print 7 * 2; print 7 / 2; print 7 % 2;',
      'print 1 == 1; print 1 != 1; print 1 < 2; print 1 <= 2; print 2 > 1; print 2 >= 1;',
      'print -3; print !true;'
    ].join('\n')

    // Folding removes them all, which proves the front end accepts every one —
    // the compile not throwing is the assertion.
    expect(() => compile(source)).not.toThrow()
  })

  it('compiles operators it cannot fold, and names them', () => {
    const program = compile(
      'fn ops(a: int, b: int) -> int { return a + b * a - b / a % b; }\nprint ops(6, 3);'
    )
    const ops = listing(program.functions.get('ops') as CompiledFunction)

    for (const operator of ['+', '-', '*', '/', '%']) {
      expect(ops, `missing ${operator}`).toContain(`binary ${operator}`)
    }
  })
})
