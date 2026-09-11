import { describe, expect, it } from 'vitest'
import { parseSource } from '../../src/lang/parser'
import { resolve, type Resolution } from '../../src/lang/symbols'
import { typeCheck, type TypeInfo } from '../../src/lang/type-check'
import { TOP_LEVEL_FUNCTION } from '../../src/lang/lower'
import {
  canonicalLowerInput,
  functionArgument,
  functionsOf,
  lowerInputFor,
  splitFunctionArgument
} from '../../src/lang/incremental'
import type { Program } from '../../src/lang/ast'

/**
 * Part 12's firewall, proven directly rather than through the daemon: the
 * canonical string for one function must be untouched by an edit to another
 * function's BODY, and must change when that edit reaches the first function's
 * only real dependency on the second — its resolved signature.
 *
 * This is the property `lang-worker.ts`'s `Q_IR`/`Q_SSA`/`Q_PASSES` queries
 * lean on entirely: if this file is wrong, the cutoff proof in
 * `test/lang/run-lang-cutoff-proof.mjs` would still exercise the real worker,
 * but nothing here would explain WHY it passed or failed.
 */

interface Analysed {
  readonly program: Program
  readonly resolution: Resolution
  readonly types: TypeInfo
}

function analyse(source: string): Analysed {
  const { program, diagnostics } = parseSource(source)
  expect(diagnostics, `parse errors in ${JSON.stringify(source)}`).toEqual([])
  const resolution = resolve(program)
  const types = typeCheck(program, resolution)
  return { program, resolution, types }
}

function canonicalFor(source: string, name: string): string {
  const { program, resolution, types } = analyse(source)
  return canonicalLowerInput(lowerInputFor(program, resolution, types, name))
}

describe('functionsOf', () => {
  it('lists every named function, then the synthetic top level, in source order', () => {
    const { program } = analyse('fn g() -> unit { } fn f() -> unit { } print 1;')
    expect(functionsOf(program).map((entry) => entry.name)).toEqual([
      'g',
      'f',
      TOP_LEVEL_FUNCTION
    ])
    expect(functionsOf(program).map((entry) => entry.isSynthetic)).toEqual([false, false, true])
  })

  it('still reports the synthetic top level when the file is all functions', () => {
    const { program } = analyse('fn f() -> unit { }')
    expect(functionsOf(program).map((entry) => entry.name)).toEqual(['f', TOP_LEVEL_FUNCTION])
  })
})

describe('lowerInputFor', () => {
  it('finds a named function’s own declaration and nothing else', () => {
    const { program, resolution, types } = analyse('fn f(x: int) -> int { return x; }')
    const input = lowerInputFor(program, resolution, types, 'f')
    expect(input.declaration?.name.text).toBe('f')
    expect(input.topLevelStatements).toBeNull()
  })

  it('gathers every non-function statement for the synthetic top level', () => {
    const { program, resolution, types } = analyse('fn f() -> unit { } let x = 1; print x;')
    const input = lowerInputFor(program, resolution, types, TOP_LEVEL_FUNCTION)
    expect(input.declaration).toBeNull()
    expect(input.topLevelStatements?.map((s) => s.kind)).toEqual(['Let', 'Print'])
  })

  it('answers null rather than throwing for a name that no longer exists', () => {
    const { program, resolution, types } = analyse('fn f() -> unit { }')
    const input = lowerInputFor(program, resolution, types, 'renamed')
    expect(input.declaration).toBeNull()
    expect(input.topLevelStatements).toBeNull()
  })
})

describe('splitFunctionArgument / functionArgument', () => {
  it('round-trips a relative path and a function name', () => {
    expect(splitFunctionArgument(functionArgument('src/fib.bcc', 'fib'))).toEqual({
      relativePath: 'src/fib.bcc',
      name: 'fib'
    })
  })

  it('defaults a bare path to the synthetic top level', () => {
    expect(splitFunctionArgument('src/fib.bcc')).toEqual({
      relativePath: 'src/fib.bcc',
      name: TOP_LEVEL_FUNCTION
    })
  })
})

describe('canonicalLowerInput', () => {
  const CALLER = 'fn f() -> int { return g(1); }\n'

  it('is identical across two independent analyses of the same source', () => {
    const source = `fn g(a: int) -> int { return a; }\n${CALLER}`
    expect(canonicalFor(source, 'f')).toBe(canonicalFor(source, 'f'))
  })

  it('does not move when an untouched sibling function is edited elsewhere', () => {
    // `f` itself is byte-for-byte identical in both sources and comes AFTER `g`,
    // so its own span is unaffected too — the strongest form of the claim.
    const before = `${CALLER}fn g(a: int) -> int { return a; }\n`
    const after = `${CALLER}fn g(a: int) -> int { return a + 1; }\n`
    expect(canonicalFor(before, 'f')).toBe(canonicalFor(after, 'f'))
  })

  it('moves when the callee’s signature changes, even though the caller’s text does not', () => {
    const before = `fn g(a: int) -> int { return a; }\n${CALLER}`
    const after = `fn g(a: int, b: int) -> int { return a + b; }\n${CALLER}`
    expect(canonicalFor(before, 'f')).not.toBe(canonicalFor(after, 'f'))
  })

  it('moves when the function itself gains a statement', () => {
    const before = 'fn f() -> int { return 1; }'
    const after = 'fn f() -> int { let x = 1; return x; }'
    expect(canonicalFor(before, 'f')).not.toBe(canonicalFor(after, 'f'))
  })

  it('moves when a function elsewhere in the file is renamed', () => {
    // `f` calls nothing here, but the lowerable-name set changed, and a call
    // added to `f` later could only be legal because of that.
    const before = 'fn other() -> unit { } fn f() -> int { return 1; }'
    const after = 'fn renamed() -> unit { } fn f() -> int { return 1; }'
    expect(canonicalFor(before, 'f')).not.toBe(canonicalFor(after, 'f'))
  })
})
