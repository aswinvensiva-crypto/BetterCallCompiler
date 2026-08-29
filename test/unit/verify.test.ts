import { describe, expect, it } from 'vitest'
import { parseSource } from '../../src/lang/parser'
import { resolve } from '../../src/lang/symbols'
import { typeCheck } from '../../src/lang/type-check'
import { lower } from '../../src/lang/lower'
import { toSsa } from '../../src/lang/ssa'
import {
  constant,
  value,
  type Block,
  type BlockId,
  type Instruction,
  type IrFunction,
  type Module,
  type Terminator
} from '../../src/lang/ir'
import {
  describeViolations,
  verifyFunction,
  verifyModule,
  VERIFICATION_RULES,
  type VerificationRule
} from '../../src/lang/verify'
import type { Span } from '../../src/lang/token'

/**
 * The verifier, tested the only way a verifier can be: by feeding it IR that is
 * wrong in exactly one way and asserting it says so.
 *
 * A verifier has two failure modes and both are silent. It can MISS a violation,
 * in which case a broken pass ships and fails three stages later in the VM. Or
 * it can INVENT one, in which case correct passes are rejected and the rule gets
 * quietly weakened until it catches nothing. So every rule below gets a case
 * that trips it, and the whole corpus of real lowerings is asserted clean.
 *
 * Assertions are on `rule` — the stable id — never on the message. The prose is
 * for a human and should stay improvable.
 */

const SPAN: Span = {
  offset: 0,
  length: 0,
  startLine: 1,
  startColumn: 1,
  endLine: 1,
  endColumn: 1
}

const ret = (): Terminator => ({ op: 'return', value: null, span: SPAN })
const jump = (target: BlockId): Terminator => ({ op: 'jump', target, span: SPAN })
const branch = (ifTrue: BlockId, ifFalse: BlockId): Terminator => ({
  op: 'branch',
  condition: constant(true),
  ifTrue,
  ifFalse,
  span: SPAN
})

function block(
  id: BlockId,
  instructions: Instruction[],
  terminator: Terminator = ret()
): Block {
  return { id, label: `b${id}`, instructions, terminator }
}

function fnWith(blocks: Block[], overrides: Partial<IrFunction> = {}): IrFunction {
  return {
    name: 'f',
    params: [],
    returnType: { kind: 'unit' },
    blocks,
    entry: 0,
    span: SPAN,
    ...overrides
  }
}

const add = (result: number, left = constant(1), right = constant(2)): Instruction => ({
  op: 'binary',
  result,
  operator: '+',
  left,
  right,
  span: SPAN
})

const print = (operand = constant(1)): Instruction => ({
  op: 'print',
  value: operand,
  span: SPAN
})

const rulesOf = (fn: IrFunction): VerificationRule[] => [
  ...new Set(verifyFunction(fn).map((violation) => violation.rule))
]

/* -------------------------------------------------------------------------- */
/*  Well-formed IR is accepted                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The corpus every real lowering is checked against.
 *
 * Missing a violation is the loud failure; INVENTING one is the quiet failure
 * that gets a rule deleted. Running the verifier over everything the compiler
 * actually produces — before and after SSA — is what keeps it honest.
 */
const PROGRAMS: readonly string[] = [
  '',
  'print 1;',
  'let x = 1; print x;',
  'let x = 1; x = x + 1; print x;',
  'if true { print 1; }',
  'if true { print 1; } else { print 2; }',
  'if true { print 1; } else if false { print 2; } else { print 3; }',
  'let i = 0; while i < 10 { i = i + 1; } print i;',
  'let i = 0; while i < 3 { let j = 0; while j < 3 { j = j + 1; } i = i + 1; }',
  'print true && false;',
  'print true || false;',
  'print (true && false) || (true && true);',
  'let x = 1; if x > 0 && x < 10 { x = 0; } print x;',
  'fn f() { }',
  'fn f() -> int { return 1; }',
  'fn add(a: int, b: int) -> int { return a + b; }',
  'fn f(a: int) -> int { if a > 0 { return 1; } else { return 2; } }',
  'fn f(a: int) -> int { while a > 0 { a = a - 1; } return a; }',
  'fn fib(n: int) -> int { if n < 2 { return n; } return fib(n - 1) + fib(n - 2); }',
  'fn f() { print 1; return; print 2; }',
  'fn nothing() { }\nnothing();',
  'fn add(a: int, b: int) -> int { return a + b; }\nprint add(1, 2);',
  'fn loops() -> int { while true { } }'
]

function moduleFor(source: string): Module {
  const { program, diagnostics } = parseSource(source)
  expect(diagnostics, `parse errors in ${JSON.stringify(source)}`).toEqual([])
  const resolution = resolve(program)
  return lower(program, resolution, typeCheck(program, resolution))
}

describe('everything the compiler actually produces verifies clean', () => {
  it.each(PROGRAMS)('accepts the lowering of %j', (source) => {
    expect(verifyModule(moduleFor(source))).toEqual([])
  })

  it.each(PROGRAMS)('accepts the SSA form of %j', (source) => {
    const module = moduleFor(source)
    const ssa: Module = { functions: module.functions.map(toSsa) }
    expect(verifyModule(ssa)).toEqual([])
  })

  it('accepts the lowering of a file the front end rejected', () => {
    // Lowering is total, so it produces IR for broken source too. That IR still
    // has to be well-formed, or Part 11 would show the Observatory something no
    // pass could run on.
    for (const source of [
      'let x = ;',
      'print nope;',
      'fn f() -> int { }',
      // Reported as BCC0014: `x` is an int, not a function. Lowering used to
      // emit `call x()` anyway, naming a callee the module does not contain —
      // caught by the verifier on its first run, and fixed in `lower.ts`.
      'let x = 1; x();',
      // Reported as BCC0010. The nested function is bound so calls to it resolve,
      // but it is never lowered as a module function, so the same hole applied.
      'fn outer() { fn inner() -> int { return 1; } print inner(); }',
      'nope(1, 2);'
    ]) {
      const { program } = parseSource(source)
      const resolution = resolve(program)
      const module = lower(program, resolution, typeCheck(program, resolution))
      expect(verifyModule(module), JSON.stringify(source)).toEqual([])
    }
  })
})

/* -------------------------------------------------------------------------- */
/*  Structure                                                                  */
/* -------------------------------------------------------------------------- */

describe('structure', () => {
  it('reports an entry that names no block', () => {
    expect(rulesOf(fnWith([block(0, [])], { entry: 7 }))).toEqual(['missing-entry-block'])
  })

  it('says nothing else once the entry is missing', () => {
    // Everything else is computed from the entry, so fifty derived violations
    // would bury the one that matters.
    const broken = fnWith([block(0, [print(value(999))], jump(42))], { entry: 7 })
    expect(rulesOf(broken)).toEqual(['missing-entry-block'])
  })

  it('reports two blocks sharing an id', () => {
    const blocks = [block(0, [], jump(1)), block(1, []), { ...block(1, []), label: 'again' }]
    expect(rulesOf(fnWith(blocks))).toContain('duplicate-block-id')
  })

  it('reports a jump to a block that does not exist', () => {
    expect(rulesOf(fnWith([block(0, [], jump(9))]))).toContain('missing-successor')
  })

  it('reports both edges of a branch that leads nowhere', () => {
    const violations = verifyFunction(fnWith([block(0, [], branch(8, 9))]))
    expect(violations.filter((v) => v.rule === 'missing-successor')).toHaveLength(2)
  })

  it('reports something branching back to the entry', () => {
    // Parameters are defined on entry before instruction zero, which is what
    // makes them dominate everything. A second way in would mean they needed a
    // phi, and every later stage assumes they do not.
    const blocks = [block(0, [], jump(1)), block(1, [], jump(0))]
    expect(rulesOf(fnWith(blocks))).toContain('entry-has-predecessors')
  })

  it('reports a block nothing reaches', () => {
    const blocks = [block(0, []), block(1, [print()])]
    expect(rulesOf(fnWith(blocks))).toContain('unreachable-block')
  })

  it('does not pile dominance failures on top of an unreachable block', () => {
    // The stranded block reads a value that genuinely does not reach it. That is
    // a CONSEQUENCE of being unreachable, not a second mistake, and reporting it
    // would bury the real one.
    const blocks = [block(0, [add(0)]), block(1, [print(value(0))])]
    expect(rulesOf(fnWith(blocks))).toEqual(['unreachable-block'])
  })
})

/* -------------------------------------------------------------------------- */
/*  Values                                                                     */
/* -------------------------------------------------------------------------- */

describe('values', () => {
  it('reports a value defined twice', () => {
    expect(rulesOf(fnWith([block(0, [add(0), add(0)])]))).toContain('duplicate-definition')
  })

  it('reports a parameter shadowed by an instruction result', () => {
    const fn = fnWith([block(0, [add(0)])], {
      params: [{ name: 'a', value: 0, type: { kind: 'int' } }]
    })
    expect(rulesOf(fn)).toContain('duplicate-definition')
  })

  it('reports a use of a value nothing defines', () => {
    expect(rulesOf(fnWith([block(0, [print(value(99))])]))).toContain('undefined-value')
  })

  it('reports a use of an undefined value from a terminator', () => {
    const terminator: Terminator = {
      op: 'branch',
      condition: value(99),
      ifTrue: 0,
      ifFalse: 0,
      span: SPAN
    }
    // Self-loop keeps both edges valid, so the only fault is the condition.
    const fn = fnWith([block(0, [], terminator), block(1, [])])
    expect(rulesOf(fn)).toContain('undefined-value')
  })

  it('reports a use earlier in the block than its definition', () => {
    expect(rulesOf(fnWith([block(0, [print(value(0)), add(0)])]))).toContain(
      'use-before-definition'
    )
  })

  it('accepts a use later in the same block', () => {
    expect(verifyFunction(fnWith([block(0, [add(0), print(value(0))])]))).toEqual([])
  })

  it('reports a definition that does not reach its use', () => {
    //      b0
    //     /  \
    //   b1    b2      %0 defined in b1
    //     \  /
    //      b3         and read in b2, which b1 does not dominate
    const blocks = [
      block(0, [], branch(1, 2)),
      block(1, [add(0)], jump(3)),
      block(2, [print(value(0))], jump(3)),
      block(3, [])
    ]
    expect(rulesOf(fnWith(blocks))).toContain('definition-does-not-dominate')
  })

  it('accepts a definition that dominates its use across blocks', () => {
    const blocks = [block(0, [add(0)], jump(1)), block(1, [print(value(0))])]
    expect(verifyFunction(fnWith(blocks))).toEqual([])
  })

  it('accepts a parameter used anywhere in the function', () => {
    // Defined before instruction zero of the entry, so it dominates everything.
    const blocks = [block(0, [], jump(1)), block(1, [print(value(0))])]
    const fn = fnWith(blocks, { params: [{ name: 'a', value: 0, type: { kind: 'int' } }] })
    expect(verifyFunction(fn)).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */
/*  Phis                                                                       */
/* -------------------------------------------------------------------------- */

const phi = (
  result: number,
  incoming: { from: BlockId; value: ReturnType<typeof constant> }[]
): Instruction => ({ op: 'phi', result, name: 'x', incoming, span: SPAN })

/** A diamond whose join carries a well-formed phi. */
function diamond(joinInstructions: Instruction[]): IrFunction {
  return fnWith([
    block(0, [], branch(1, 2)),
    block(1, [add(10)], jump(3)),
    block(2, [add(11)], jump(3)),
    block(3, joinInstructions)
  ])
}

describe('phis', () => {
  it('accepts a well-formed phi at a join', () => {
    const fn = diamond([
      phi(12, [
        { from: 1, value: value(10) },
        { from: 2, value: value(11) }
      ]),
      print(value(12))
    ])
    expect(verifyFunction(fn)).toEqual([])
  })

  it('reports a phi after an ordinary instruction', () => {
    const fn = diamond([
      print(),
      phi(12, [
        { from: 1, value: value(10) },
        { from: 2, value: value(11) }
      ])
    ])
    expect(rulesOf(fn)).toContain('phi-not-at-block-start')
  })

  it('reports a phi in the entry block', () => {
    // Nothing branches to the entry, so a phi there has no edges to choose from.
    expect(rulesOf(fnWith([block(0, [phi(0, [])])]))).toContain('phi-in-entry-block')
  })

  it('reports a phi with too few arguments', () => {
    const fn = diamond([phi(12, [{ from: 1, value: value(10) }])])
    expect(rulesOf(fn)).toContain('phi-arity-mismatch')
  })

  it('reports a phi with too many arguments', () => {
    const fn = diamond([
      phi(12, [
        { from: 1, value: value(10) },
        { from: 2, value: value(11) },
        { from: 2, value: value(11) }
      ])
    ])
    expect(rulesOf(fn)).toContain('phi-arity-mismatch')
  })

  it('counts EDGES, not predecessor blocks', () => {
    // `branch %c, join, join` reaches the join twice from one block, so a phi
    // there needs two arguments. A verifier counting distinct predecessors would
    // accept one and let a real bug through.
    const blocks = [
      block(0, [add(10)], branch(1, 1)),
      block(1, [phi(12, [{ from: 0, value: value(10) }])])
    ]
    expect(rulesOf(fnWith(blocks))).toContain('phi-arity-mismatch')

    const fixed = [
      block(0, [add(10)], branch(1, 1)),
      block(
        1,
        [
          phi(12, [
            { from: 0, value: value(10) },
            { from: 0, value: value(10) }
          ])
        ]
      )
    ]
    expect(verifyFunction(fnWith(fixed))).toEqual([])
  })

  it('reports a phi argument attributed to the wrong edge', () => {
    const fn = diamond([
      phi(12, [
        { from: 2, value: value(10) },
        { from: 1, value: value(11) }
      ])
    ])
    expect(rulesOf(fn)).toContain('phi-predecessor-mismatch')
  })

  it('reports a phi argument that does not reach the edge it comes in on', () => {
    // %11 is defined in b2 but offered on the edge from b1. The result dominates
    // and the arity matches, so nothing but this rule catches it — and the
    // program computes something else.
    const fn = diamond([
      phi(12, [
        { from: 1, value: value(11) },
        { from: 2, value: value(11) }
      ])
    ])
    expect(rulesOf(fn)).toContain('phi-operand-does-not-dominate')
  })

  it('checks a phi argument against its predecessor, not against the phi block', () => {
    // The regression this rule exists for. %10 is defined in b1, which does NOT
    // dominate the join — that is exactly why the phi is there. A verifier that
    // checked against the join would reject this correct function.
    const fn = diamond([
      phi(12, [
        { from: 1, value: value(10) },
        { from: 2, value: value(11) }
      ])
    ])
    expect(verifyFunction(fn)).toEqual([])
  })

  it('accepts a constant phi argument', () => {
    const fn = diamond([
      phi(12, [
        { from: 1, value: constant(0) },
        { from: 2, value: constant(1) }
      ])
    ])
    expect(verifyFunction(fn)).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */
/*  Memory and signatures                                                      */
/* -------------------------------------------------------------------------- */

describe('memory', () => {
  const alloca = (result: number): Instruction => ({
    op: 'alloca',
    result,
    name: 'x',
    type: { kind: 'int' },
    span: SPAN
  })

  it('accepts a load and a store through an alloca', () => {
    const instructions: Instruction[] = [
      alloca(0),
      { op: 'store', slot: 0, value: constant(1), span: SPAN },
      { op: 'load', result: 1, slot: 0, span: SPAN }
    ]
    expect(verifyFunction(fnWith([block(0, instructions)]))).toEqual([])
  })

  it('reports a load through something that is not a slot', () => {
    const instructions: Instruction[] = [add(0), { op: 'load', result: 1, slot: 0, span: SPAN }]
    expect(rulesOf(fnWith([block(0, instructions)]))).toContain('slot-is-not-an-alloca')
  })

  it('reports a store through something that is not a slot', () => {
    const instructions: Instruction[] = [
      add(0),
      { op: 'store', slot: 0, value: constant(1), span: SPAN }
    ]
    expect(rulesOf(fnWith([block(0, instructions)]))).toContain('slot-is-not-an-alloca')
  })
})

describe('signatures', () => {
  it('reports returning a value from a unit function', () => {
    const terminator: Terminator = { op: 'return', value: constant(1), span: SPAN }
    expect(rulesOf(fnWith([block(0, [], terminator)]))).toContain('return-value-mismatch')
  })

  it('reports returning nothing from a function that promises a value', () => {
    const fn = fnWith([block(0, [])], { returnType: { kind: 'int' } })
    expect(rulesOf(fn)).toContain('return-value-mismatch')
  })

  it('exempts unreachable, which promises nothing', () => {
    const fn = fnWith([block(0, [], { op: 'unreachable', span: SPAN })], {
      returnType: { kind: 'int' }
    })
    expect(verifyFunction(fn)).toEqual([])
  })

  it('says nothing about a function whose return type is already poisoned', () => {
    // The type checker has reported it. A second message about the same mistake
    // is noise.
    const fn = fnWith([block(0, [])], { returnType: { kind: 'error' } })
    expect(verifyFunction(fn)).toEqual([])
  })

  it('reports a call to a function the module does not define', () => {
    const call: Instruction = { op: 'call', result: null, callee: 'nope', args: [], span: SPAN }
    const module: Module = { functions: [fnWith([block(0, [call])])] }
    expect(verifyModule(module).map((v) => v.rule)).toContain('unknown-callee')
  })

  it('reports a call with the wrong number of arguments', () => {
    const callee = fnWith([block(0, [])], {
      name: 'g',
      params: [{ name: 'a', value: 0, type: { kind: 'int' } }]
    })
    const call: Instruction = { op: 'call', result: null, callee: 'g', args: [], span: SPAN }
    const module: Module = { functions: [callee, fnWith([block(0, [call])])] }
    expect(verifyModule(module).map((v) => v.rule)).toContain('call-arity-mismatch')
  })

  it('reports two functions sharing a name', () => {
    // `fn f() {} fn f() {}` is BCC0009 in the source, but lowering emits BOTH,
    // so the module really does contain two functions called `f` and `call f()`
    // has no single meaning. Found by checking what the compiler actually
    // produces rather than by reading the rule list.
    const source = 'fn f() -> int { return 1; }\nfn f() -> int { return 2; }\nprint f();'
    const { program } = parseSource(source)
    const resolution = resolve(program)
    const module = lower(program, resolution, typeCheck(program, resolution))

    expect(module.functions.map((fn) => fn.name)).toEqual(['f', 'f', '<main>'])
    expect(verifyModule(module).map((violation) => violation.rule)).toContain(
      'duplicate-function-name'
    )
  })

  it('reports a duplicate name even when no front end was involved', () => {
    // A Part 8 pass that clones a function introduces the same fault with no
    // source behind it, which is why this is an IR rule rather than a re-report
    // of BCC0009.
    const one = fnWith([block(0, [])], { name: 'g' })
    expect(verifyModule({ functions: [one, one] }).map((v) => v.rule)).toContain(
      'duplicate-function-name'
    )
  })

  it('accepts a call that matches', () => {
    const callee = fnWith([block(0, [])], {
      name: 'g',
      params: [{ name: 'a', value: 0, type: { kind: 'int' } }]
    })
    const call: Instruction = {
      op: 'call',
      result: null,
      callee: 'g',
      args: [constant(1)],
      span: SPAN
    }
    expect(verifyModule({ functions: [callee, fnWith([block(0, [call])])] })).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */
/*  The verifier itself                                                        */
/* -------------------------------------------------------------------------- */

describe('the verifier as a tool', () => {
  it('never throws, however malformed the input', () => {
    // This is what you reach for when you already suspect the IR is broken.
    // Crashing would make it useless exactly when it is needed.
    const nonsense: IrFunction[] = [
      fnWith([]),
      fnWith([], { entry: 3 }),
      fnWith([block(0, [], jump(-1))]),
      fnWith([block(0, [phi(0, [{ from: 99, value: value(99) }])])]),
      fnWith([block(0, [{ op: 'load', result: 0, slot: 0, span: SPAN }])]),
      fnWith([block(5, [])], { entry: 5 }),
      fnWith([block(0, []), block(0, []), block(0, [])])
    ]

    for (const fn of nonsense) {
      expect(() => verifyFunction(fn), JSON.stringify(fn.name)).not.toThrow()
    }
    expect(() => verifyModule({ functions: nonsense })).not.toThrow()
  })

  it('names the function and block every violation was found in', () => {
    const fn = fnWith([block(0, [], jump(1)), block(1, [print(value(99))])], { name: 'guilty' })
    const violations = verifyFunction(fn)
    expect(violations.length).toBeGreaterThan(0)
    for (const violation of violations) {
      expect(violation.fn).toBe('guilty')
      expect(violation.message.length).toBeGreaterThan(0)
    }
    expect(violations.some((violation) => violation.block === 'b1')).toBe(true)
  })

  it('describes every rule it can report', () => {
    for (const [rule, description] of Object.entries(VERIFICATION_RULES)) {
      expect(description.length, rule).toBeGreaterThan(0)
    }
  })

  it('renders violations one per line, with the rule that fired', () => {
    // What a Part 8 pass failure will actually print.
    const text = describeViolations(verifyFunction(fnWith([block(0, [print(value(9))])])))
    expect(text).toContain('undefined-value')
    expect(text).toContain('f:b0')
  })

  it('reports an empty list for a clean function rather than a truthy object', () => {
    expect(verifyFunction(fnWith([block(0, [])]))).toEqual([])
    expect(verifyModule({ functions: [] })).toEqual([])
  })

  /**
   * The test that keeps this file honest as rules are added.
   *
   * Every rule in the table must be reachable by at least one case above. A
   * rule nobody can trip is either dead or wrong, and both are worse than not
   * having it — it reads as coverage that is not there.
   */
  it('exercises every rule it declares', () => {
    const declared = Object.keys(VERIFICATION_RULES) as VerificationRule[]

    const tripped = new Set<VerificationRule>([
      ...rulesOf(fnWith([block(0, [])], { entry: 7 })),
      ...rulesOf(fnWith([block(0, [], jump(1)), block(1, []), { ...block(1, []), label: 'x' }])),
      ...rulesOf(fnWith([block(0, [], jump(9))])),
      ...rulesOf(fnWith([block(0, [], jump(1)), block(1, [], jump(0))])),
      ...rulesOf(fnWith([block(0, []), block(1, [print()])])),
      ...rulesOf(fnWith([block(0, [add(0), add(0)])])),
      ...rulesOf(fnWith([block(0, [print(value(99))])])),
      ...rulesOf(fnWith([block(0, [print(value(0)), add(0)])])),
      ...rulesOf(
        fnWith([
          block(0, [], branch(1, 2)),
          block(1, [add(0)], jump(3)),
          block(2, [print(value(0))], jump(3)),
          block(3, [])
        ])
      ),
      ...rulesOf(
        diamond([
          print(),
          phi(12, [
            { from: 1, value: value(10) },
            { from: 2, value: value(11) }
          ])
        ])
      ),
      ...rulesOf(fnWith([block(0, [phi(0, [])])])),
      ...rulesOf(diamond([phi(12, [{ from: 1, value: value(10) }])])),
      ...rulesOf(
        diamond([
          phi(12, [
            { from: 2, value: value(10) },
            { from: 1, value: value(11) }
          ])
        ])
      ),
      ...rulesOf(
        diamond([
          phi(12, [
            { from: 1, value: value(11) },
            { from: 2, value: value(11) }
          ])
        ])
      ),
      ...rulesOf(fnWith([block(0, [add(0), { op: 'load', result: 1, slot: 0, span: SPAN }])])),
      ...rulesOf(fnWith([block(0, [], { op: 'return', value: constant(1), span: SPAN })])),
      ...verifyModule({
        functions: [
          fnWith([
            block(0, [{ op: 'call', result: null, callee: 'nope', args: [], span: SPAN }])
          ])
        ]
      }).map((violation) => violation.rule),
      ...verifyModule({
        functions: [
          fnWith([block(0, [])], {
            name: 'g',
            params: [{ name: 'a', value: 0, type: { kind: 'int' } }]
          }),
          fnWith([
            block(0, [{ op: 'call', result: null, callee: 'g', args: [], span: SPAN }])
          ])
        ]
      }).map((violation) => violation.rule),
      ...verifyModule({
        functions: [fnWith([block(0, [])], { name: 'g' }), fnWith([block(0, [])], { name: 'g' })]
      }).map((violation) => violation.rule)
    ])

    const never = declared.filter((rule) => !tripped.has(rule))
    expect(never, `rules no case trips: ${never.join(', ')}`).toEqual([])
  })
})
