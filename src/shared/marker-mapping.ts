import { clampRange, type ModelExtent } from './diagnostic-position'
import type { DiagnosticMessage, DiagnosticSeverity, FileDiagnostics } from './types'

/**
 * Diagnostics to Monaco marker data.
 *
 * Deliberately imports nothing from `monaco-editor`. The moment it does, a
 * Node-side unit test pulling this in also pulls the whole editor bundle and
 * its `?worker` module specifiers, which only Vite can resolve — the test then
 * fails on an import rather than on anything it was written to check. Same
 * pure/impure split `security.ts` makes against `index.ts`.
 *
 * The severities are Monaco's numeric scale, inlined rather than imported for
 * the same reason. They are a stable part of the public API.
 */

export interface MarkerData {
  /** 8 Error, 4 Warning, 2 Info, 1 Hint — `monaco.MarkerSeverity`. */
  readonly severity: number
  readonly message: string
  readonly code: string
  readonly source: string
  readonly startLineNumber: number
  readonly startColumn: number
  readonly endLineNumber: number
  readonly endColumn: number
}

export const MARKER_SEVERITY: Readonly<Record<DiagnosticSeverity, number>> = {
  error: 8,
  warning: 4,
  info: 2,
  hint: 1
}

export function toMonacoMarkers(
  file: FileDiagnostics,
  extent: ModelExtent
): MarkerData[] {
  return file.diagnostics.map((diagnostic: DiagnosticMessage) => {
    const range = clampRange(
      {
        startLine: diagnostic.startLine,
        startColumn: diagnostic.startColumn,
        endLine: diagnostic.endLine,
        endColumn: diagnostic.endColumn
      },
      extent
    )

    return {
      severity: MARKER_SEVERITY[diagnostic.severity],
      message: diagnostic.message,
      code: diagnostic.code,
      source: diagnostic.source,
      startLineNumber: range.startLine,
      startColumn: range.startColumn,
      endLineNumber: range.endLine,
      endColumn: range.endColumn
    }
  })
}
