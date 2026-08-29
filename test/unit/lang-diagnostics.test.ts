import { describe, expect, it } from 'vitest'
import { clampRange, lineStartsOf, positionAt } from '../../src/shared/diagnostic-position'
import { parseSource } from '../../src/lang/parser'
import {
  BCC_EXTENSION,
  isBccPath,
  toDiagnosticMessages
} from '../../src/shared/lang-diagnostics'
import { diagnosticMessageSchema } from '../../src/shared/types'

/**
 * The bridge from BCC's diagnostics to the IDE's.
 *
 * Twenty lines of mapping, and everything downstream depends on them being
 * right: get the shape wrong and zod rejects the batch at the IPC boundary;
 * get the POSITIONS wrong and the squiggle lands on the wrong token with
 * nothing to point back here.
 */

describe('isBccPath', () => {
  it('claims .bcc and nothing else', () => {
    expect(isBccPath('examples/fib.bcc')).toBe(true)
    expect(isBccPath('a.bcc')).toBe(true)
    expect(isBccPath('src/app.ts')).toBe(false)
    expect(isBccPath('README.md')).toBe(false)
    // Not a suffix match on the name: `.bcc` has to be the extension.
    expect(isBccPath('notbcc')).toBe(false)
  })

  it('is case-insensitive, because Windows is', () => {
    expect(isBccPath('Examples/FIB.BCC')).toBe(true)
  })

  it('exports the extension it matches on', () => {
    expect(BCC_EXTENSION).toBe('.bcc')
    expect(isBccPath(`x${BCC_EXTENSION}`)).toBe(true)
  })
})

describe('toDiagnosticMessages', () => {
  const convert = (source: string) =>
    toDiagnosticMessages('a.bcc', '/w/a.bcc', parseSource(source).diagnostics)

  it('produces messages the IPC schema accepts', () => {
    // The schema is `strictObject` with positive-integer positions, so a
    // missing field or a zero column is a rejected batch at the boundary
    // rather than a wrong squiggle. Worth asserting directly: nothing else in
    // the pipeline validates until it is too late to debug.
    const messages = convert('let x = 1\nprint @ ;\nf() = 1;')
    expect(messages.length).toBeGreaterThan(0)

    for (const message of messages) {
      expect(() => diagnosticMessageSchema.parse(message)).not.toThrow()
    }
  })

  it('carries the BCC code through unchanged', () => {
    const [message] = convert('f() = 1;')
    expect(message?.code).toBe('BCC0006')
    expect(message?.source).toBe('bcc')
  })

  it('keeps both paths, because the two sides join on different ones', () => {
    const [message] = convert('let = 1;')
    // relativePath is the key every side joins on; path is what the renderer
    // opens without re-deriving the workspace root.
    expect(message?.relativePath).toBe('a.bcc')
    expect(message?.path).toBe('/w/a.bcc')
  })

  it('reports positions that agree with the offset-based mapping', () => {
    // BCC spans carry 1-based line and column directly — the payoff for Part 1
    // threading them rather than only an offset. TypeScript diagnostics arrive
    // as {start, length} and go through `positionAt`. Both land in the same
    // `DiagnosticMessage`, so the two mappings must agree or a BCC squiggle and
    // a TS squiggle on the same line would sit on different lines.
    for (const source of [
      'let x = 1\nlet y = 2\nlet z\n',
      'fn f() {\n  return\n}\n',
      'let a = 1;\r\nlet b\r\nprint b;\r\n'
    ]) {
      const lineStarts = lineStartsOf(source)
      for (const diagnostic of parseSource(source).diagnostics) {
        const expected = positionAt(lineStarts, diagnostic.span.offset)
        expect(diagnostic.span.startLine, source).toBe(expected.line)
        expect(diagnostic.span.startColumn, source).toBe(expected.column)
      }
    }
  })

  it('emits zero-width spans, which clampRange widens for Monaco', () => {
    // A missing `;` is reported at a POSITION. Monaco draws nothing for a
    // zero-width marker, so if this were not widened the most common
    // diagnostic in a half-typed file would be invisible. It is widened by
    // machinery that already existed — asserted here so a change to
    // `clampRange` cannot silently take BCC's squiggles away.
    const [message] = convert('let x = 1\n')
    expect(message?.code).toBe('BCC0003')
    expect(message?.startColumn).toBe(message?.endColumn)

    const widened = clampRange(
      {
        startLine: message!.startLine,
        startColumn: message!.startColumn,
        endLine: message!.endLine,
        endColumn: message!.endColumn
      },
      { lineCount: 2, lineMaxColumn: () => 20 }
    )
    expect(widened.endColumn).toBeGreaterThan(widened.startColumn)
  })

  it('returns nothing for a clean file', () => {
    expect(convert('fn add(a: int, b: int) -> int { return a + b; }')).toEqual([])
  })
})
