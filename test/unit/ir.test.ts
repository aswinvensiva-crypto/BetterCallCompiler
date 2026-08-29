import { describe, expect, it } from 'vitest'
import { parseSource } from '../../src/lang/parser'
import { resolve } from '../../src/lang/symbols'
import { typeCheck } from '../../src/lang/type-check'
import { lower, TOP_LEVEL_FUNCTION } from '../../src/lang/lower'
import {
  definitionOf,
  predecessorsOf,
  printFunction,
  printModule,
  reachableBlocks,
  successorsOf,
  terminatorUses,
  usesOf,
  type Block,
  type Instruction,
  type IrFunction,
  type Module
} from '../../src/lang/ir'

/**
 * Lowering, and the invariants the IR is only useful if it has.
 *
 * The plan asks for CFG-shape tests plus two invariants checked on every
 * lowering. One of the two — a single terminator per block — is enforced by the
 * TYPE rather than checked here: `terminator` is its own field, so a block with
 * two or none cannot be constructed. That is strictly stronger than a runtime
 * check, so the effort goes into the invariant a type cannot express (one
 * definition per value) and into three more that Parts 6 to 9 will silently
 * depend on: every successor exists, every use is of a value something defines,
 * and every block is reachable.
 *
 * Golden text rather than object assertions for the shape tests. `printFunction`
 * is what the Observatory shows and what Part 8 diffs, so a test that reads it
 * is a test of the thing a person will actually look at — and a wrong CFG is
 * obvious in eleven lines of IR in a way it never is in a nested object.
 */

function moduleFor(source: string): Module {
  const { program, diagnostics } = parseSource(source)
  expect(diagnostics, `parse errors in ${JSON.stringify(source)}`).toEqual([])
  const resolution = resolve(program)
  const types = typeCheck(program, resolution)
  return lower(program, resolution, types)
}

function functionNamed(source: string, name: string): IrFunction {
  const found = moduleFor(source).functions.find((fn) => fn.name === name)
  if (found === undefined) throw new Error(`no function called ${name}`)
  return found
}

const printed = (source: string, name: string): string => printFunction(functionNamed(source, name))

/** Every instruction in a function, in block order. */
function allInstructions(fn: IrFunction): Instruction[] {
  return fn.blocks.flatMap((block: Block) => [...block.instructions])
}

const opsIn = (fn: IrFunction): string[] =>
  allInstructions(fn).map((instruction) => instruction.op)

/**
 * A spread of programs every invariant runs over.
 *
 * Includes the awkward shapes on purpose: nested loops, an if with no else, a
 * function that returns from inside a loop, short-circuits nested in each
 * other. Those are where a builder that tracks "the current block" in one
 * mutable variable goes wrong.
 */
const CORPUS: readonly string[] = [
  '',
  'print 1;',
  'let x = 1; print x;',
  'let x = 1; x = x + 1; print x;',
  'print 1 + 2 * 3 - 4;',
  'print -1;',
  'print !true;',
  'if true { print 1; }',
  'if true { print 1; } else { print 2; }',
  'if true { print 1; } else if false { print 2; } else { print 3; }',
  'let i = 0; while i < 10 { i = i + 1; }',
  'let i = 0; while i < 3 { let j = 0; while j < 3 { j = j + 1; } i = i + 1; }',
  'print true && false;',
  'print true || false;',
  'print true && false || true;',
  'print (true && false) && (true || false);',
  'let x = 1; if x > 0 && x < 10 { print x; }',
  'fn f() { }',
  'fn f() -> int { return 1; }',
  'fn add(a: int, b: int) -> int { return a + b; }',
  'fn f(a: int) -> int { if a > 0 { return 1; } else { return 2; } }',
  'fn f(a: int) -> int { while a > 0 { return a; } return 0; }',
  'fn fib(n: int) -> int { if n < 2 { return n; } return fib(n - 1) + fib(n - 2); }',
  'fn f() { print 1; return; print 2; }',
  'fn nothing() { }\nnothing();',
  'fn add(a: int, b: int) -> int { return a + b; }\nprint add(1, 2);',
  '{ let x = 1; { let y = 2; print x + y; } }'
]

/* -------------------------------------------------------------------------- */
/*  Invariants                                                                 */
/* -------------------------------------------------------------------------- */

describe('every lowering holds its invariants', () => {
  const everyFunction = (): { source: string; fn: IrFunction }[] =>
    CORPUS.flatMap((source) =>
      moduleFor(source).functions.map((fn) => ({ source, fn }))
    )

  /**
   * One definition per value — the invariant the type cannot express, and the
   * one everything after this depends on.
   *
   * Part 6 renames values assuming each is defined once; Part 8's copy
   * propagation walks def-use chains assuming a use has one definition to find.
   * If a builder ever reuses an id, both produce confidently wrong code rather
   * than failing.
   */
  it('defines every value exactly once', () => {
    for (const { source, fn } of everyFunction()) {
      const seen = new Set<number>()

      for (const param of fn.params) {
        expect(seen.has(param.value), `${fn.name} in ${JSON.stringify(source)}`).toBe(false)
        seen.add(param.value)
      }

      for (const instruction of allInstructions(fn)) {
        const defined = definitionOf(instruction)
        if (defined === null) continue
        expect(
          seen.has(defined),
          `%${defined} defined twice in ${fn.name} of ${JSON.stringify(source)}`
        ).toBe(false)
        seen.add(defined)
      }
    }
  })

  it('only ever uses a value something defines', () => {
    // A use of an undefined value is a dangling pointer by another name. It
    // survives every pass and surfaces in Part 9 as a VM reading a register
    // nobody wrote.
    for (const { source, fn } of everyFunction()) {
      const defined = new Set<number>(fn.params.map((param) => param.value))
      for (const instruction of allInstructions(fn)) {
        const result = definitionOf(instruction)
        if (result !== null) defined.add(result)
      }

      for (const instruction of allInstructions(fn)) {
        for (const used of usesOf(instruction)) {
          expect(
            defined.has(used),
            `%${used} used but never defined in ${fn.name} of ${JSON.stringify(source)}`
          ).toBe(true)
        }
      }

      for (const block of fn.blocks) {
        for (const used of terminatorUses(block.terminator)) {
          expect(defined.has(used), `terminator of ${block.label}`).toBe(true)
        }
      }
    }
  })

  it('only ever branches to a block that exists', () => {
    for (const { source, fn } of everyFunction()) {
      const ids = new Set(fn.blocks.map((block) => block.id))
      for (const block of fn.blocks) {
        for (const successor of successorsOf(block.terminator)) {
          expect(
            ids.has(successor),
            `${block.label} jumps to a missing block in ${JSON.stringify(source)}`
          ).toBe(true)
        }
      }
    }
  })

  it('leaves no block stranded', () => {
    // A block nothing reaches is dead weight the Observatory would draw and
    // Part 6 would compute dominance for. The lowering never creates one —
    // statements after a terminator are dropped rather than emitted into an
    // orphan block.
    for (const { source, fn } of everyFunction()) {
      const reachable = reachableBlocks(fn)
      for (const block of fn.blocks) {
        expect(
          reachable.has(block.id),
          `${block.label} is unreachable in ${fn.name} of ${JSON.stringify(source)}`
        ).toBe(true)
      }
    }
  })

  it('starts every function at block 0 and gives it an entry', () => {
    for (const { fn } of everyFunction()) {
      expect(fn.entry).toBe(0)
      expect(fn.blocks[0]?.label).toBe('entry.0')
    }
  })

  it('keeps predecessors and successors agreeing with each other', () => {
    for (const { source, fn } of everyFunction()) {
      const predecessors = predecessorsOf(fn)
      for (const block of fn.blocks) {
        for (const successor of successorsOf(block.terminator)) {
          expect(
            predecessors.get(successor),
            `${block.label} -> ${successor} in ${JSON.stringify(source)}`
          ).toContain(block.id)
        }
      }
    }
  })

  it('gives every instruction a span inside the source', () => {
    // Part 9 turns this mapping into the debug info: a breakpoint is a span
    // looked up to an instruction. A span invented here is a breakpoint that
    // lands on the wrong line there, with nothing pointing back.
    for (const source of CORPUS) {
      for (const fn of moduleFor(source).functions) {
        for (const instruction of allInstructions(fn)) {
          expect(instruction.span.offset, JSON.stringify(source)).toBeGreaterThanOrEqual(0)
          expect(
            instruction.span.offset + instruction.span.length,
            JSON.stringify(source)
          ).toBeLessThanOrEqual(source.length)
        }
      }
    }
  })
})

/* -------------------------------------------------------------------------- */
/*  Shape                                                                      */
/* -------------------------------------------------------------------------- */

describe('the module', () => {
  it('lowers each function, plus a synthetic one for the top level', () => {
    const module = moduleFor('fn a() { }\nfn b() { }\nprint 1;')
    expect(module.functions.map((fn) => fn.name)).toEqual(['a', 'b', TOP_LEVEL_FUNCTION])
  })

  it('names the top-level function something no source can declare', () => {
    // `<` and `>` are not identifier characters, so the collision is impossible
    // by construction rather than merely unlikely.
    expect(TOP_LEVEL_FUNCTION).toBe('<main>')
    expect(parseSource('fn <main>() { }').diagnostics.length).toBeGreaterThan(0)
  })

  it('emits the top-level function even for an empty file', () => {
    // Part 9 always needs somewhere to start.
    const module = moduleFor('')
    expect(module.functions.map((fn) => fn.name)).toEqual([TOP_LEVEL_FUNCTION])
    expect(module.functions[0]?.blocks).toHaveLength(1)
  })

  it('does not lower a nested function into its parent', () => {
    // The resolver already rejected it; lowering it into the enclosing body
    // would put a second function's code inside the first.
    const { program } = parseSource('fn outer() { fn inner() { print 1; } }')
    const resolution = resolve(program)
    const module = lower(program, resolution, typeCheck(program, resolution))
    expect(module.functions.map((fn) => fn.name)).toEqual(['outer', TOP_LEVEL_FUNCTION])
  })
})

describe('straight-line code', () => {
  it('lowers a let and a use to alloca, store, load', () => {
    expect(printed('let x = 1; print x;', TOP_LEVEL_FUNCTION)).toBe(
      [
        'fn <main>() -> unit {',
        'entry.0:',
        '  %0 = alloca x: int',
        '  store %0, 1',
        '  %1 = load %0',
        '  print %1',
        '  ret',
        '}'
      ].join('\n')
    )
  })

  it('keeps constants as operands rather than making them instructions', () => {
    // `%2 = add %0, 1` reads the way a person would write it, and it is what
    // makes constant folding in Part 8 a rewrite of operands.
    expect(printed('print 1 + 2;', TOP_LEVEL_FUNCTION)).toContain('%0 = + 1, 2')
  })

  it('respects precedence in the order it emits', () => {
    // The multiplication has to be computed before the addition can use it.
    const text = printed('print 1 + 2 * 3;', TOP_LEVEL_FUNCTION)
    expect(text).toContain('%0 = * 2, 3')
    expect(text).toContain('%1 = + 1, %0')
  })

  it('copies parameters into slots so they can be assigned', () => {
    expect(printed('fn add(a: int, b: int) -> int { return a + b; }', 'add')).toBe(
      [
        'fn add(%0: int, %1: int) -> int {',
        'entry.0:',
        '  %2 = alloca a: int',
        '  store %2, %0',
        '  %3 = alloca b: int',
        '  store %3, %1',
        '  %4 = load %2',
        '  %5 = load %3',
        '  %6 = + %4, %5',
        '  ret %6',
        '}'
      ].join('\n')
    )
  })

  it('hoists allocas into the entry block, even for a let inside a loop', () => {
    // Otherwise each iteration allocates a fresh slot — and mem2reg in Part 8
    // only promotes entry-block allocas, for exactly this reason.
    const fn = functionNamed('while true { let x = 1; print x; }', TOP_LEVEL_FUNCTION)
    const entryAllocas = (fn.blocks[0]?.instructions ?? []).filter(
      (instruction) => instruction.op === 'alloca'
    )
    expect(entryAllocas).toHaveLength(1)
    expect(opsIn(fn).filter((op) => op === 'alloca')).toHaveLength(1)
  })
})

describe('control flow', () => {
  it('lowers if/else to a branch and a join', () => {
    expect(printed('if true { print 1; } else { print 2; }', TOP_LEVEL_FUNCTION)).toBe(
      [
        'fn <main>() -> unit {',
        'entry.0:',
        '  branch true, then.1, else.2',
        'then.1:',
        '  print 1',
        '  jump join.3',
        'else.2:',
        '  print 2',
        '  jump join.3',
        'join.3:',
        '  ret',
        '}'
      ].join('\n')
    )
  })

  it('sends the false edge straight to the join when there is no else', () => {
    const fn = functionNamed('if true { print 1; }', TOP_LEVEL_FUNCTION)
    const terminator = fn.blocks[0]?.terminator
    expect(terminator?.op).toBe('branch')
    if (terminator?.op !== 'branch') throw new Error('expected a branch')
    // No empty else block: the join IS the false successor.
    expect(fn.blocks.map((block) => block.label)).toEqual(['entry.0', 'then.1', 'join.2'])
    expect(terminator.ifFalse).toBe(2)
  })

  it('gives a while loop its own condition block, so the back edge is visible', () => {
    expect(printed('while true { print 1; }', TOP_LEVEL_FUNCTION)).toBe(
      [
        'fn <main>() -> unit {',
        'entry.0:',
        '  jump while.head.1',
        'while.head.1:',
        '  branch true, while.body.2, while.exit.3',
        'while.body.2:',
        '  print 1',
        '  jump while.head.1',
        'while.exit.3:',
        '  ret',
        '}'
      ].join('\n')
    )
  })

  it('makes the loop head its own predecessor through the back edge', () => {
    // The back edge is what makes the head a loop header, and it is what
    // Part 6's dominance calculation has to walk.
    const fn = functionNamed('while true { print 1; }', TOP_LEVEL_FUNCTION)
    const predecessors = predecessorsOf(fn)
    expect(predecessors.get(1)).toEqual([0, 2])
  })

  it('nests loops without confusing which head a back edge belongs to', () => {
    const fn = functionNamed(
      'let i = 0; while i < 2 { let j = 0; while j < 2 { j = j + 1; } i = i + 1; }',
      TOP_LEVEL_FUNCTION
    )
    const predecessors = predecessorsOf(fn)
    const heads = fn.blocks.filter((block) => block.label.startsWith('while.head'))
    expect(heads).toHaveLength(2)
    // Each head has exactly two predecessors: the way in, and its own back edge.
    for (const head of heads) {
      expect(predecessors.get(head.id)).toHaveLength(2)
    }
  })

  it('chains else-if without inventing an extra block', () => {
    const fn = functionNamed(
      'if true { print 1; } else if false { print 2; } else { print 3; }',
      TOP_LEVEL_FUNCTION
    )
    // Two branches for two conditions, and no block is unreachable.
    const branches = fn.blocks.filter((block) => block.terminator.op === 'branch')
    expect(branches).toHaveLength(2)
    expect(reachableBlocks(fn).size).toBe(fn.blocks.length)
  })

  it('drops statements after a return rather than stranding a block', () => {
    const fn = functionNamed('fn f() { print 1; return; print 2; }', 'f')
    expect(opsIn(fn).filter((op) => op === 'print')).toHaveLength(1)
    expect(reachableBlocks(fn).size).toBe(fn.blocks.length)
  })

  it('ends a value-returning function that falls off the end as unreachable', () => {
    // The checker has already reported BCC0016. `unreachable` says which of the
    // two this is, instead of inventing a return value nobody wrote.
    const { program } = parseSource('fn f() -> int { print 1; }')
    const resolution = resolve(program)
    const module = lower(program, resolution, typeCheck(program, resolution))
    const fn = module.functions[0]
    expect(fn?.blocks[0]?.terminator.op).toBe('unreachable')
  })

  it('closes a unit function with a plain return', () => {
    expect(functionNamed('fn f() { print 1; }', 'f').blocks[0]?.terminator.op).toBe('return')
  })
})

describe('short-circuit operators', () => {
  /**
   * The lowering the whole plan leans on.
   *
   * `&&` becomes a branch, a slot and a join — which is a lot of machinery for
   * one operator, and exactly the point. Part 6 puts a phi at that join and
   * Part 8's mem2reg deletes the slot, and a reader watches an `&&` turn into
   * control flow and then back into a value.
   */
  it('lowers && to a branch that skips the right side', () => {
    expect(printed('print true && false;', TOP_LEVEL_FUNCTION)).toBe(
      [
        'fn <main>() -> unit {',
        'entry.0:',
        '  %0 = alloca and: bool',
        '  store %0, true',
        '  branch true, and.rhs.1, and.join.2',
        'and.rhs.1:',
        '  store %0, false',
        '  jump and.join.2',
        'and.join.2:',
        '  %1 = load %0',
        '  print %1',
        '  ret',
        '}'
      ].join('\n')
    )
  })

  it('lowers || with the edges the other way round', () => {
    // The only difference between the two operators, and it is one line in the
    // lowering: `||` evaluates its right side when the left is FALSE.
    const fn = functionNamed('print true || false;', TOP_LEVEL_FUNCTION)
    const terminator = fn.blocks[0]?.terminator
    if (terminator?.op !== 'branch') throw new Error('expected a branch')
    expect(fn.blocks[terminator.ifTrue]?.label).toBe('or.join.2')
    expect(fn.blocks[terminator.ifFalse]?.label).toBe('or.rhs.1')
  })

  it('does not evaluate the right side on the short path', () => {
    // The proof that this is short-circuiting rather than decoration: the call
    // is in the rhs block, so the path that skips it never runs it.
    const fn = functionNamed(
      'fn side() -> bool { return true; }\nprint false && side();',
      TOP_LEVEL_FUNCTION
    )
    const rhs = fn.blocks.find((block) => block.label.startsWith('and.rhs'))
    expect(rhs?.instructions.some((instruction) => instruction.op === 'call')).toBe(true)
    expect(fn.blocks[0]?.instructions.some((instruction) => instruction.op === 'call')).toBe(false)
  })

  it('nests short-circuits without the joins colliding', () => {
    const fn = functionNamed('print (true && false) || (true && true);', TOP_LEVEL_FUNCTION)
    const labels = fn.blocks.map((block) => block.label)
    expect(new Set(labels).size).toBe(labels.length)
    expect(reachableBlocks(fn).size).toBe(fn.blocks.length)
  })
})

describe('calls', () => {
  it('names the result of a call that returns a value', () => {
    expect(printed('fn f() -> int { return 1; }\nprint f();', TOP_LEVEL_FUNCTION)).toContain(
      '%0 = call f()'
    )
  })

  it('names nothing for a call that returns unit', () => {
    const text = printed('fn f() { }\nf();', TOP_LEVEL_FUNCTION)
    expect(text).toContain('call f()')
    expect(text).not.toContain('= call f()')
  })

  it('evaluates arguments before the call', () => {
    const text = printed('fn f(a: int) { }\nf(1 + 2);', TOP_LEVEL_FUNCTION)
    expect(text).toContain('%0 = + 1, 2')
    expect(text).toContain('call f(%0)')
  })

  it('lowers recursion as an ordinary call', () => {
    const text = printed(
      'fn fib(n: int) -> int { if n < 2 { return n; } return fib(n - 1) + fib(n - 2); }',
      'fib'
    )
    expect(text.match(/call fib/g)).toHaveLength(2)
  })
})

describe('defs and uses', () => {
  it('counts a store as using its slot', () => {
    // Liveness that ignored this would be free to delete the alloca out from
    // under the store that writes to it.
    const fn = functionNamed('let x = 1;', TOP_LEVEL_FUNCTION)
    const store = allInstructions(fn).find((instruction) => instruction.op === 'store')
    expect(store).toBeDefined()
    expect(usesOf(store!)).toEqual([0])
    expect(definitionOf(store!)).toBeNull()
  })

  it('reports both edges of a branch, even when they are the same block', () => {
    // A branch to one place twice is still two edges, and phi arity in Part 6
    // has to match the number of incoming edges rather than of predecessors.
    expect(
      successorsOf({
        op: 'branch',
        condition: { kind: 'const', value: true },
        ifTrue: 3,
        ifFalse: 3,
        span: { offset: 0, length: 0, startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 }
      })
    ).toEqual([3, 3])
  })
})

describe('a broken file still lowers', () => {
  /**
   * Programs the front end rejected, lowered anyway.
   *
   * Part 11 will show the IR for whatever is in the editor buffer, which is
   * broken on most keystrokes. Lowering has the same obligation the lexer and
   * parser took on: never throw, and produce something well-formed enough for
   * the next stage to walk. `ErrorExpr` becomes a constant and an unresolved
   * name is skipped, so the surrounding function still lowers.
   */
  const BROKEN: readonly string[] = [
    'let x = ;',
    'let x = 1',
    'print nope;',
    'print nope + 1;',
    'fn f() -> int { }',
    'fn f(a: nope) { }',
    'let x: int = true; print x + 1;',
    'return 1;',
    'fn f() { fn g() { print 1; } }',
    'f();',
    'let x = 1; x();',
    'if 1 { print 2; }',
    'while { }',
    '}}}',
    'fn f() { ) ) ) }'
  ]

  const lowerBroken = (source: string): Module => {
    const { program } = parseSource(source)
    const resolution = resolve(program)
    return lower(program, resolution, typeCheck(program, resolution))
  }

  it.each(BROKEN)('does not throw on %j', (source) => {
    expect(() => lowerBroken(source)).not.toThrow()
  })

  it('still holds every invariant on a broken file', () => {
    for (const source of BROKEN) {
      for (const fn of lowerBroken(source).functions) {
        const defined = new Set<number>(fn.params.map((param) => param.value))
        for (const instruction of allInstructions(fn)) {
          const result = definitionOf(instruction)
          if (result === null) continue
          expect(defined.has(result), `%${result} twice in ${JSON.stringify(source)}`).toBe(false)
          defined.add(result)
        }

        for (const instruction of allInstructions(fn)) {
          for (const used of usesOf(instruction)) {
            expect(defined.has(used), `%${used} undefined in ${JSON.stringify(source)}`).toBe(true)
          }
        }

        expect(reachableBlocks(fn).size, JSON.stringify(source)).toBe(fn.blocks.length)
      }
    }
  })
})

describe('printing', () => {
  it('renders a whole module with a blank line between functions', () => {
    const text = printModule(moduleFor('fn f() { }'))
    expect(text).toContain('fn f() -> unit {')
    expect(text).toContain(`fn ${TOP_LEVEL_FUNCTION}() -> unit {`)
    expect(text.split('\n\n')).toHaveLength(2)
  })

  it('is stable, so a golden diff shows only what a pass changed', () => {
    const source = 'fn f(a: int) -> int { if a > 0 { return a; } return 0; }'
    expect(printed(source, 'f')).toBe(printed(source, 'f'))
  })
})
