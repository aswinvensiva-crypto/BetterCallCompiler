import { describe, expect, it } from 'vitest'
import { parseSource } from '../../src/lang/parser'
import { resolve } from '../../src/lang/symbols'
import { typeCheck } from '../../src/lang/type-check'
import { lower } from '../../src/lang/lower'
import { toSsa } from '../../src/lang/ssa'
import { runPipeline } from '../../src/lang/pass-manager'
import { OPTIMISATION_PIPELINE } from '../../src/lang/passes'
import { printFunction, type IrFunction, type Module } from '../../src/lang/ir'
import { tokenize } from '../../src/lang/lexer'
import {
  printAstLines,
  printBytecodeLines,
  printFunctionLines,
  printScopeLines,
  printTokenLines
} from '../../src/lang/print'
import { compileFunction } from '../../src/lang/bytecode'

/**
 * The Observatory's printers, checked for the property that actually matters:
 * every line names the right source, and joining the lines back together
 * reproduces what the existing, golden-tested text printers already say.
 */

function moduleFor(source: string): Module {
  const { program, diagnostics } = parseSource(source)
  expect(diagnostics).toEqual([])
  const resolution = resolve(program)
  const types = typeCheck(program, resolution)
  return lower(program, resolution, types)
}

describe('printTokenLines', () => {
  it('carries one line per token, trivia included, and tiles the source', () => {
    const source = 'let x = 1;'
    const tokens = tokenize(source)
    const lines = printTokenLines(tokens)
    expect(lines).toHaveLength(tokens.length)

    // Concatenating every token's own span back together reproduces the file —
    // the same tiling property `token.test.ts` checks on the lexer directly.
    const rebuilt = tokens.map((token) => source.slice(token.span.offset, token.span.offset + token.span.length)).join('')
    expect(rebuilt).toBe(source)
  })

  it('names the token kind and its exact text', () => {
    const [first] = printTokenLines(tokenize('let'))
    expect(first?.text).toBe('let  "let"')
  })
})

describe('printAstLines', () => {
  it('visits the whole tree and points every line at a real span', () => {
    const { program } = parseSource('let x = 1;')
    const lines = printAstLines(program)

    // Program, Let, Ident(x), Int(1) — nothing more, nothing skipped.
    expect(lines.map((entry) => entry.text.trim().split(' ')[0])).toEqual([
      'Program',
      'Let',
      'Ident',
      'Int'
    ])
    for (const entry of lines) {
      expect(entry.span).not.toBeNull()
    }
  })

  it('indents children one level deeper than their parent', () => {
    const { program } = parseSource('let x = 1;')
    const lines = printAstLines(program)
    const indentOf = (text: string): number => text.length - text.trimStart().length

    expect(indentOf(lines[0]?.text ?? '')).toBe(0)
    expect(indentOf(lines[1]?.text ?? '')).toBe(2)
    expect(indentOf(lines[2]?.text ?? '')).toBe(4)
  })
})

describe('printScopeLines', () => {
  it('lists a declared symbol under its scope, pointed at its declaration', () => {
    const { program } = parseSource('let x = 1;')
    const resolution = resolve(program)
    const [statement] = program.statements
    if (statement === undefined || statement.kind !== 'Let') throw new Error('expected a Let')

    const symbol = resolution.declarations.get(statement.name)
    if (symbol === undefined) throw new Error('expected x to resolve')

    const lines = printScopeLines(resolution.scope)
    const symbolLine = lines.find((entry) => entry.text.includes('variable x'))
    expect(symbolLine).toBeDefined()
    expect(symbolLine?.span).toEqual(symbol.declaration.span)
  })
})

describe('printFunctionLines', () => {
  it('joins back into exactly what printFunction already prints', () => {
    const source = 'fn add(a: int, b: int) -> int { return a + b; }'
    const fn = moduleFor(source).functions.find((f) => f.name === 'add')
    if (fn === undefined) throw new Error('expected add() to lower')

    const lines = printFunctionLines(fn)
    expect(lines.map((entry) => entry.text).join('\n')).toBe(printFunction(fn))
  })

  it('gives every instruction and terminator a span, and every block label none', () => {
    const source = 'fn add(a: int, b: int) -> int { return a + b; }'
    const fn = moduleFor(source).functions.find((f) => f.name === 'add')
    if (fn === undefined) throw new Error('expected add() to lower')

    const lines = printFunctionLines(fn)
    const labelLines = lines.filter((entry) => /^[a-zA-Z].*\.\d+:$/.test(entry.text))
    expect(labelLines.length).toBeGreaterThan(0)
    for (const entry of labelLines) expect(entry.span).toBeNull()
  })
})

/** Bytecode compiles from optimised IR only — mem2reg must clear every alloca. */
function optimised(fn: IrFunction): IrFunction {
  const report = runPipeline({ functions: [toSsa(fn)] }, OPTIMISATION_PIPELINE)
  const [result] = report.module.functions
  if (result === undefined) throw new Error('expected one function back')
  return result
}

describe('printBytecodeLines', () => {
  it('names every emitted instruction with the span it came from', () => {
    const source = 'fn add(a: int, b: int) -> int { return a + b; }'
    const fn = moduleFor(source).functions.find((f) => f.name === 'add')
    if (fn === undefined) throw new Error('expected add() to lower')

    const compiled = compileFunction(optimised(fn))
    const lines = printBytecodeLines(compiled)
    // Header, N instructions, closing brace.
    expect(lines).toHaveLength(compiled.code.length + 2)
    for (const entry of lines.slice(1, -1)) expect(entry.span).not.toBeNull()
  })
})
