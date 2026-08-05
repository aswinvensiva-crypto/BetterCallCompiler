/**
 * Character offsets to 1-based line/column.
 *
 * `ts.Diagnostic` reports `{ start, length }` as offsets into the file text.
 * Monaco wants `{ startLineNumber, startColumn, endLineNumber, endColumn }`,
 * 1-based on both axes. The conversion is three lines of arithmetic and exactly
 * the kind of thing that is wrong by one somewhere and nobody notices until a
 * squiggle sits under the wrong token — which is why it lives in its own pure
 * module with its own tests rather than inline in the worker.
 *
 * Pure: no node, no electron, no typescript, no DOM.
 */

export interface Position {
  /** 1-based. */
  readonly line: number
  /** 1-based. */
  readonly column: number
}

export interface Range {
  readonly startLine: number
  readonly startColumn: number
  readonly endLine: number
  readonly endColumn: number
}

/**
 * Offsets at which each line begins, `lineStarts[0] === 0`.
 *
 * Computed once per file and reused for every diagnostic in it: a file with
 * forty errors would otherwise rescan the text forty times.
 *
 * CRLF needs no special handling. `\r` is an ordinary character that belongs to
 * the line it terminates, so only `\n` starts a new one — which also means a
 * column on a CRLF line counts the `\r`, exactly as Monaco does.
 */
export function lineStartsOf(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1)
  }
  return starts
}

/**
 * The 1-based position of `offset`.
 *
 * Binary search rather than a linear scan: a diagnostic near the end of a
 * 10 000-line file would otherwise walk every preceding line.
 *
 * An offset past the end of the text clamps to the final position instead of
 * returning NaN. TypeScript can report a diagnostic at EOF — an unterminated
 * block, for instance — and the range it gives is legitimately one past the
 * last character.
 */
export function positionAt(lineStarts: readonly number[], offset: number): Position {
  if (lineStarts.length === 0) return { line: 1, column: 1 }

  const clamped = Math.max(0, offset)

  let low = 0
  let high = lineStarts.length - 1
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if ((lineStarts[mid] ?? 0) <= clamped) low = mid
    else high = mid - 1
  }

  return { line: low + 1, column: clamped - (lineStarts[low] ?? 0) + 1 }
}

export interface ModelExtent {
  readonly lineCount: number
  /** Maximum valid column on a line — Monaco's `getLineMaxColumn`, 1-based. */
  readonly lineMaxColumn: (line: number) => number
}

/**
 * Clamps a range to what a model can actually hold.
 *
 * The daemon reads files from disk while the editor holds a buffer that may
 * already differ — the user keeps typing while a check is in flight. A range
 * computed against stale text can therefore point past the end of the current
 * model, and Monaco silently drops a marker whose range is out of bounds. It
 * does not warn; the squiggle simply never appears. Clamping puts the marker
 * somewhere slightly wrong rather than nowhere at all.
 */
export function clampRange(range: Range, extent: ModelExtent): Range {
  const lineCount = Math.max(1, extent.lineCount)

  const startLine = Math.min(Math.max(1, range.startLine), lineCount)
  const endLine = Math.min(Math.max(startLine, range.endLine), lineCount)

  const startMax = Math.max(1, extent.lineMaxColumn(startLine))
  const endMax = Math.max(1, extent.lineMaxColumn(endLine))

  let startColumn = Math.min(Math.max(1, range.startColumn), startMax)
  let endColumn = Math.min(Math.max(1, range.endColumn), endMax)

  // A zero-width range draws nothing. Widen it by one so a diagnostic that
  // points at a position rather than a span is still visible.
  if (startLine === endLine && endColumn <= startColumn) {
    if (startColumn < endMax) endColumn = startColumn + 1
    else if (startColumn > 1) startColumn = startColumn - 1
    else endColumn = startColumn
  }

  return { startLine, startColumn, endLine, endColumn }
}

/** `{start, length}` in file text to a 1-based range. */
export function rangeFromSpan(
  lineStarts: readonly number[],
  start: number,
  length: number
): Range {
  const from = positionAt(lineStarts, start)
  const to = positionAt(lineStarts, start + Math.max(0, length))

  return {
    startLine: from.line,
    startColumn: from.column,
    endLine: to.line,
    endColumn: to.column
  }
}
