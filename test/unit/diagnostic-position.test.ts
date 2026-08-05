import { describe, expect, it } from 'vitest'
import {
  clampRange,
  lineStartsOf,
  positionAt,
  rangeFromSpan,
  type ModelExtent
} from '../../src/shared/diagnostic-position'

/** A model of fixed-width lines, enough to exercise clamping. */
function extentOf(lineLengths: readonly number[]): ModelExtent {
  return {
    lineCount: lineLengths.length,
    // Monaco's getLineMaxColumn is length + 1: the caret can sit past the last
    // character, so a marker may legitimately end there.
    lineMaxColumn: (line) => (lineLengths[line - 1] ?? 0) + 1
  }
}

describe('lineStartsOf', () => {
  it('always starts at offset 0', () => {
    expect(lineStartsOf('')).toEqual([0])
    expect(lineStartsOf('abc')).toEqual([0])
  })

  it('records the offset after each newline', () => {
    expect(lineStartsOf('ab\ncd\nef')).toEqual([0, 3, 6])
  })

  it('counts a trailing newline as opening a further line', () => {
    // A file ending in \n really does have an empty final line, and a
    // diagnostic at EOF lands on it.
    expect(lineStartsOf('ab\n')).toEqual([0, 3])
  })

  it('treats CRLF as one line break, with \\r belonging to the line it ends', () => {
    // Offsets: a=0 b=1 \r=2 \n=3, so line 2 starts at 4.
    expect(lineStartsOf('ab\r\ncd')).toEqual([0, 4])
  })
})

describe('positionAt', () => {
  const text = 'abc\ndefgh\nij'
  const starts = lineStartsOf(text)

  it('maps offset 0 to line 1, column 1', () => {
    expect(positionAt(starts, 0)).toEqual({ line: 1, column: 1 })
  })

  it('maps within a line', () => {
    // 'abc\ndefgh\nij' — line 2 starts at offset 4, so offset 6 is 'f'.
    expect(positionAt(starts, 2)).toEqual({ line: 1, column: 3 })
    expect(positionAt(starts, 6)).toEqual({ line: 2, column: 3 })
  })

  /**
   * The offset of a `\n` belongs to the line it terminates, not the next one.
   * Getting this backwards puts every end-of-line diagnostic on the wrong line.
   */
  it('maps the offset of a newline to the end of the line it closes', () => {
    expect(positionAt(starts, 3)).toEqual({ line: 1, column: 4 })
  })

  it('maps the offset just after a newline to the start of the next line', () => {
    expect(positionAt(starts, 4)).toEqual({ line: 2, column: 1 })
  })

  it('clamps past-EOF to the last position rather than returning NaN', () => {
    // TypeScript legitimately reports diagnostics at EOF for unterminated
    // constructs, and NaN here would silently drop the marker.
    const result = positionAt(starts, 9999)
    expect(Number.isFinite(result.line)).toBe(true)
    expect(Number.isFinite(result.column)).toBe(true)
    expect(result.line).toBe(3)
  })

  it('clamps a negative offset to the start', () => {
    expect(positionAt(starts, -5)).toEqual({ line: 1, column: 1 })
  })

  it('handles an empty file', () => {
    expect(positionAt(lineStartsOf(''), 0)).toEqual({ line: 1, column: 1 })
  })

  it('agrees with a linear scan across a large file', () => {
    // Guards the binary search against an off-by-one that only shows up past
    // the first few lines.
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`)
    const big = lines.join('\n')
    const bigStarts = lineStartsOf(big)

    for (const offset of [0, 7, 8, 9, 100, 1000, big.length - 1, big.length]) {
      const viaSearch = positionAt(bigStarts, offset)
      const before = big.slice(0, offset)
      const expectedLine = before.split('\n').length
      expect(viaSearch.line).toBe(expectedLine)
    }
  })
})

describe('rangeFromSpan', () => {
  const starts = lineStartsOf('abc\ndefgh\nij')

  it('converts a span inside one line', () => {
    expect(rangeFromSpan(starts, 4, 3)).toEqual({
      startLine: 2,
      startColumn: 1,
      endLine: 2,
      endColumn: 4
    })
  })

  it('converts a span that crosses a line break', () => {
    expect(rangeFromSpan(starts, 1, 5)).toEqual({
      startLine: 1,
      startColumn: 2,
      endLine: 2,
      endColumn: 3
    })
  })

  it('treats a zero-length span as an empty range at that point', () => {
    expect(rangeFromSpan(starts, 5, 0)).toEqual({
      startLine: 2,
      startColumn: 2,
      endLine: 2,
      endColumn: 2
    })
  })

  it('does not produce NaN for a negative length', () => {
    const range = rangeFromSpan(starts, 5, -3)
    expect(Object.values(range).every(Number.isFinite)).toBe(true)
  })
})

describe('clampRange', () => {
  const extent = extentOf([3, 5, 2]) // "abc", "defgh", "ij"

  it('leaves an in-bounds range alone', () => {
    const range = { startLine: 2, startColumn: 2, endLine: 2, endColumn: 4 }
    expect(clampRange(range, extent)).toEqual(range)
  })

  /**
   * The daemon reads from disk while the editor holds a newer buffer, so a
   * range can legitimately point past the current model. Monaco drops an
   * out-of-bounds marker silently — no warning, the squiggle just never
   * appears — so clamping is what keeps it visible.
   */
  it('clamps a line past the end of the model', () => {
    const result = clampRange(
      { startLine: 99, startColumn: 1, endLine: 99, endColumn: 5 },
      extent
    )
    expect(result.startLine).toBe(3)
    expect(result.endLine).toBe(3)
  })

  it('clamps a column past the end of its line', () => {
    const result = clampRange(
      { startLine: 3, startColumn: 50, endLine: 3, endColumn: 90 },
      extent
    )
    // "ij" has max column 3.
    expect(result.startColumn).toBeLessThanOrEqual(3)
    expect(result.endColumn).toBeLessThanOrEqual(3)
  })

  it('widens a zero-width range so it still draws', () => {
    const result = clampRange(
      { startLine: 2, startColumn: 3, endLine: 2, endColumn: 3 },
      extent
    )
    expect(result.endColumn).toBeGreaterThan(result.startColumn)
  })

  it('widens backwards when the range sits at the very end of a line', () => {
    // Column 6 is the max for "defgh"; there is nothing to the right, so the
    // range has to grow leftwards instead of vanishing.
    const result = clampRange(
      { startLine: 2, startColumn: 6, endLine: 2, endColumn: 6 },
      extent
    )
    expect(result.endColumn).toBeGreaterThan(result.startColumn)
  })

  it('never produces a column below 1', () => {
    const result = clampRange(
      { startLine: 1, startColumn: -4, endLine: 1, endColumn: 0 },
      extent
    )
    expect(result.startColumn).toBeGreaterThanOrEqual(1)
    expect(result.endColumn).toBeGreaterThanOrEqual(1)
  })

  it('never lets the end precede the start', () => {
    const result = clampRange(
      { startLine: 3, startColumn: 2, endLine: 1, endColumn: 1 },
      extent
    )
    expect(result.endLine).toBeGreaterThanOrEqual(result.startLine)
  })

  it('survives an empty model', () => {
    const result = clampRange(
      { startLine: 5, startColumn: 5, endLine: 5, endColumn: 9 },
      extentOf([])
    )
    expect(result.startLine).toBe(1)
    expect(Object.values(result).every((n) => Number.isFinite(n) && n >= 1)).toBe(true)
  })
})
