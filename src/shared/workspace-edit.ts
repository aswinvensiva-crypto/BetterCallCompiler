import { lineStartsOf, positionAt } from './diagnostic-position'
import type { FileEdit, TextEdit } from './types'

/**
 * Applying a set of range edits to a file's text.
 *
 * Pure, and in `src/shared` for the reason `pass-analysis.ts` is: this is the
 * arithmetic behind a rename, and a rename that gets it wrong corrupts source
 * files. It deserves unit tests that need neither a window nor a worker.
 *
 * ## Descending, and why the order is load-bearing
 *
 * Every edit's range is expressed against the ORIGINAL text. Applying the first
 * one shifts everything after it, so an edit applied second at a range computed
 * before the first would land in the wrong place — off by exactly the length
 * difference of every earlier edit. Applying from the end backwards means no
 * applied edit can move a range not yet applied, which turns a bookkeeping
 * problem into an ordering one.
 *
 * The daemon already produces its edits descending. Sorting again here is not
 * distrust so much as the guarantee living where the arithmetic does: a caller
 * that assembles edits from two sources should not have to know.
 *
 * ## Refusing rather than guessing
 *
 * Overlapping edits, and ranges past the end of the file, are REFUSED. Both
 * mean the caller's view of the file and this text have diverged — the file
 * changed on disk between the query and the write, most likely — and the two
 * available responses are "apply something the user did not ask for" and
 * "apply nothing and say so". A half-renamed symbol is the worst possible
 * outcome, so the whole operation fails and the file is left alone.
 */

export type EditResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: string }

interface Resolved {
  readonly start: number
  readonly end: number
  readonly newText: string
}

/**
 * A 1-based line/column to a character offset.
 *
 * The inverse of `positionAt`, and the exclusive-end convention is the same:
 * column 1 is the position before the first character, so `column - 1` is the
 * offset within the line.
 */
function offsetAt(
  lineStarts: readonly number[],
  textLength: number,
  line: number,
  column: number
): number | null {
  if (line < 1 || line > lineStarts.length) return null
  const lineStart = lineStarts[line - 1]
  if (lineStart === undefined) return null

  // The line ends where the next one starts, or at the end of the text for the
  // last line. A column past that is a range describing a file this is not.
  const lineEnd = lineStarts[line] ?? textLength + 1
  const offset = lineStart + column - 1
  if (column < 1 || offset > textLength || offset >= lineEnd + 1) return null
  return offset
}

export function applyTextEdits(text: string, edits: readonly TextEdit[]): EditResult {
  if (edits.length === 0) return { ok: true, text }

  const lineStarts = lineStartsOf(text)
  const resolved: Resolved[] = []

  for (const edit of edits) {
    const start = offsetAt(lineStarts, text.length, edit.range.startLine, edit.range.startColumn)
    const end = offsetAt(lineStarts, text.length, edit.range.endLine, edit.range.endColumn)

    if (start === null || end === null) {
      return {
        ok: false,
        reason: `an edit at ${edit.range.startLine}:${edit.range.startColumn} is outside the file`
      }
    }
    if (end < start) {
      return { ok: false, reason: `an edit at ${edit.range.startLine} ends before it begins` }
    }
    resolved.push({ start, end, newText: edit.newText })
  }

  // Descending by start, so applying in order cannot move a range not yet
  // applied. Ties broken by end, so two edits at the same point are still
  // ordered deterministically rather than by the sort's stability.
  resolved.sort((a, b) => (b.start === a.start ? b.end - a.end : b.start - a.start))

  for (let i = 1; i < resolved.length; i++) {
    const later = resolved[i - 1] as Resolved
    const earlier = resolved[i] as Resolved
    // Walking from the end: `earlier` must finish before `later` begins.
    // Touching is fine — two adjacent replacements are not a conflict — so the
    // comparison is strict.
    if (earlier.end > later.start) {
      const where = positionAt(lineStarts, later.start)
      return {
        ok: false,
        reason: `two edits overlap at ${where.line}:${where.column}`
      }
    }
  }

  let result = text
  for (const edit of resolved) {
    result = result.slice(0, edit.start) + edit.newText + result.slice(edit.end)
  }

  return { ok: true, text: result }
}

/**
 * Every file an edit set names, deduplicated, in the order first seen.
 *
 * Used by the caller that has to read them all before writing any of them —
 * the all-or-nothing rule needs the reads to happen first.
 */
export function editedPaths(files: readonly FileEdit[]): string[] {
  const seen = new Set<string>()
  const paths: string[] = []
  for (const file of files) {
    if (seen.has(file.path)) continue
    seen.add(file.path)
    paths.push(file.path)
  }
  return paths
}
