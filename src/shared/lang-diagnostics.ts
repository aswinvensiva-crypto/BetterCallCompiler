import type { Diagnostic } from '../lang/diagnostic'
import type { DiagnosticMessage } from './types'

/**
 * BCC diagnostics, in the shape the rest of the IDE already understands.
 *
 * This module is the whole integration. `src/lang/` produces its own
 * `Diagnostic` and knows nothing about IPC; the Problems panel, Monaco markers
 * and the status bar all consume `DiagnosticMessage`. Twenty lines here mean
 * none of them need to change, and none of them need to know a second compiler
 * exists.
 *
 * It lives in `src/shared` rather than in the worker so it can be tested
 * without spawning a thread — the same reason `marker-mapping.ts` and
 * `pass-analysis.ts` do.
 *
 * The direction of the dependency is deliberate: `shared` may import `lang`,
 * because `shared` is the protocol layer and the compiler is the thing being
 * described. `lang` must never import `shared`, or the compiler would be
 * coupled to this IDE's wire format.
 */

/** The extension BCC owns. One constant; the plan says change it freely. */
export const BCC_EXTENSION = '.bcc'

export function isBccPath(path: string): boolean {
  return path.toLowerCase().endsWith(BCC_EXTENSION)
}

/**
 * Maps BCC's diagnostics onto the IPC shape.
 *
 * The position mapping is a straight copy, and that is the payoff for Part 1
 * carrying 1-based line and column on every span rather than only an offset.
 * TypeScript diagnostics arrive as `{ start, length }` and have to be converted
 * through `lineStartsOf`/`positionAt`; these arrive ready.
 *
 * Zero-width spans are passed through as they are. A missing `;` is reported at
 * a position rather than over a range, and `clampRange` in
 * `diagnostic-position.ts` already widens a zero-width range by one column so
 * Monaco draws something — which is why the most common diagnostic in a
 * half-typed file needs no special handling here.
 */
export function toDiagnosticMessages(
  relativePath: string,
  absolutePath: string,
  diagnostics: readonly Diagnostic[]
): DiagnosticMessage[] {
  return diagnostics.map((diagnostic) => ({
    relativePath,
    path: absolutePath,
    severity: diagnostic.severity,
    code: diagnostic.code,
    message: diagnostic.message,
    startLine: diagnostic.span.startLine,
    startColumn: diagnostic.span.startColumn,
    endLine: diagnostic.span.endLine,
    endColumn: diagnostic.span.endColumn,
    source: 'bcc' as const
  }))
}
