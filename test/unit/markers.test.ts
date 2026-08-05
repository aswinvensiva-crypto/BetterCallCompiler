import { describe, expect, it } from 'vitest'
import { toMonacoMarkers } from '../../src/shared/marker-mapping'
import type { ModelExtent } from '../../src/shared/diagnostic-position'
import type { DiagnosticMessage, FileDiagnostics } from '../../src/shared/types'

/**
 * `toMonacoMarkers` is the pure half of the marker layer; the `setModelMarkers`
 * call around it is a thin shell. Same split `security.ts` makes against
 * `index.ts`, and it is what lets the mapping be tested without an editor.
 */

function extentOf(lineLengths: readonly number[]): ModelExtent {
  return {
    lineCount: lineLengths.length,
    lineMaxColumn: (line) => (lineLengths[line - 1] ?? 0) + 1
  }
}

function diagnostic(overrides: Partial<DiagnosticMessage> = {}): DiagnosticMessage {
  return {
    relativePath: 'src/a.ts',
    path: 'C:/ws/src/a.ts',
    severity: 'error',
    code: 'TS2345',
    message: 'not assignable',
    startLine: 1,
    startColumn: 1,
    endLine: 1,
    endColumn: 3,
    source: 'typescript',
    ...overrides
  }
}

function file(diagnostics: DiagnosticMessage[]): FileDiagnostics {
  return { relativePath: 'src/a.ts', path: 'C:/ws/src/a.ts', diagnostics, version: 1 }
}

describe('toMonacoMarkers', () => {
  it('maps a diagnostic to Monaco 1-based marker fields', () => {
    const [marker] = toMonacoMarkers(
      file([diagnostic({ startLine: 2, startColumn: 5, endLine: 2, endColumn: 9 })]),
      extentOf([10, 20])
    )

    expect(marker).toMatchObject({
      startLineNumber: 2,
      startColumn: 5,
      endLineNumber: 2,
      endColumn: 9,
      message: 'not assignable',
      code: 'TS2345',
      source: 'typescript'
    })
  })

  it('maps each severity to Monaco\u2019s numeric scale', () => {
    const markers = toMonacoMarkers(
      file([
        diagnostic({ severity: 'error' }),
        diagnostic({ severity: 'warning' }),
        diagnostic({ severity: 'info' }),
        diagnostic({ severity: 'hint' })
      ]),
      extentOf([10])
    )

    // 8 = Error, 4 = Warning, 2 = Info, 1 = Hint.
    expect(markers.map((m) => m.severity)).toEqual([8, 4, 2, 1])
  })

  /**
   * The daemon reads from disk while the editor holds a newer buffer, so a
   * range can point past the current model. Monaco drops an out-of-bounds
   * marker silently — no warning, the squiggle just never appears.
   */
  it('clamps a range that points past the end of the model', () => {
    const [marker] = toMonacoMarkers(
      file([diagnostic({ startLine: 99, startColumn: 40, endLine: 99, endColumn: 80 })]),
      extentOf([10, 20])
    )

    expect(marker?.startLineNumber).toBe(2)
    expect(marker?.endLineNumber).toBe(2)
    expect(marker?.endColumn).toBeLessThanOrEqual(21)
  })

  it('widens a zero-width range so it is still drawn', () => {
    const [marker] = toMonacoMarkers(
      file([diagnostic({ startLine: 1, startColumn: 4, endLine: 1, endColumn: 4 })]),
      extentOf([10])
    )

    expect(marker?.endColumn).toBeGreaterThan(marker?.startColumn ?? 0)
  })

  it('carries the source so graph warnings can be told from compiler output', () => {
    const [marker] = toMonacoMarkers(
      file([diagnostic({ code: 'TS-CYCLE', source: 'graph', severity: 'warning' })]),
      extentOf([10])
    )

    expect(marker).toMatchObject({ code: 'TS-CYCLE', source: 'graph', severity: 4 })
  })

  /** The empty set is how a fixed error's squiggle clears. */
  it('produces no markers for a clean file', () => {
    expect(toMonacoMarkers(file([]), extentOf([10]))).toEqual([])
  })

  it('maps every diagnostic in a file, preserving order', () => {
    const markers = toMonacoMarkers(
      file([
        diagnostic({ message: 'first' }),
        diagnostic({ message: 'second' }),
        diagnostic({ message: 'third' })
      ]),
      extentOf([10])
    )

    expect(markers.map((m) => m.message)).toEqual(['first', 'second', 'third'])
  })
})
