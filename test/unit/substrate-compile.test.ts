import { describe, expect, it } from 'vitest'
import { FRONT_STAGES, compile } from '../../src/renderer/views/substrate/compile'
import { provenanceAt } from '../../src/renderer/views/substrate/provenance'

/**
 * Substrate's compile pipeline, against the real compiler.
 *
 * The view names the stage an error belongs to — the header, the stage cards
 * and the Types body all read `stage` — so attribution is what these pin. A
 * syntax error reported under Types would send the reader to the wrong stage
 * of the pipeline, which is exactly what this file exists to prevent.
 */

describe('compile', () => {
  it('reports a clean program as unblocked, with IR and SSA produced', () => {
    const result = compile('let x: int = 1; print x;')

    expect(result.diagnostics).toEqual([])
    expect(result.blocked).toBe(false)
    expect(result.ir.length).toBeGreaterThan(0)
    expect(result.ssa.length).toBeGreaterThan(0)
  })

  it('attributes a syntax error to the AST stage, not Types', () => {
    const result = compile('fn add(a: int, b: int) -> int {\n  return a + b\n}\n')

    expect(result.blocked).toBe(true)
    expect(result.diagnostics.map((d) => [d.code, d.stage])).toEqual([['BCC0003', 'ast']])
  })

  it('attributes a bad character to the Tokens stage', () => {
    const result = compile('let x = 1 @ 2;')

    const lexical = result.diagnostics.find((d) => d.code === 'BCC0001')
    expect(lexical?.stage).toBe('tokens')
  })

  it('attributes an unknown name to the Symbols stage', () => {
    const result = compile('print y;')

    expect(result.diagnostics.map((d) => [d.code, d.stage])).toEqual([['BCC0008', 'symbols']])
  })

  it('attributes a type mismatch to the Types stage', () => {
    const result = compile('let x: int = true;')

    expect(result.diagnostics.map((d) => [d.code, d.stage])).toEqual([['BCC0012', 'types']])
  })

  it('only ever tags a diagnostic with a front-end stage', () => {
    const samples = [
      'let x = 1 @ 2;',
      'fn add(a: int, b: int) -> int {\n  return a + b\n}\n',
      'print y;',
      'let x: int = true;'
    ]
    for (const source of samples) {
      for (const d of compile(source).diagnostics) {
        expect(FRONT_STAGES).toContain(d.stage)
      }
    }
  })
})

describe('provenanceAt', () => {
  it('finds the token under the caret', () => {
    const source = 'let total = 1;'
    const result = compile(source)

    const provenance = provenanceAt(result, source.indexOf('total'))
    expect(provenance?.token?.text).toBe('total')
  })

  it('ignores the end-of-file token, so resting at the end selects nothing', () => {
    const source = 'let total = 1;'
    const result = compile(source)

    const provenance = provenanceAt(result, source.length)
    expect(provenance?.token ?? null).toBeNull()
  })
})
