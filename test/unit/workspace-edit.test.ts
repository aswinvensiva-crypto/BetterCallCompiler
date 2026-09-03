import { describe, expect, it } from 'vitest'
import { applyTextEdits, editedPaths } from '../../src/shared/workspace-edit'
import type { TextEdit } from '../../src/shared/types'

/**
 * The arithmetic behind a rename.
 *
 * Worth its own file for one reason: getting it wrong corrupts source files,
 * and a half-renamed symbol is a worse outcome than a rename that refuses. Two
 * properties carry it — edits apply from the end backwards so no applied edit
 * can move a range not yet applied, and anything that says the caller's view of
 * the file has diverged from this text is REFUSED rather than guessed at.
 */

const edit = (
  startLine: number,
  startColumn: number,
  endLine: number,
  endColumn: number,
  newText: string
): TextEdit => ({
  range: { startLine, startColumn, endLine, endColumn },
  newText
})

describe('applyTextEdits', () => {
  it('returns the text untouched when there is nothing to do', () => {
    expect(applyTextEdits('let x = 1\n', [])).toEqual({ ok: true, text: 'let x = 1\n' })
  })

  it('replaces one range', () => {
    const result = applyTextEdits('let count = 1\n', [edit(1, 5, 1, 10, 'total')])
    expect(result).toEqual({ ok: true, text: 'let total = 1\n' })
  })

  /**
   * The property the whole module exists for.
   *
   * Every range is expressed against the ORIGINAL text, and `renamed` is longer
   * than `x`. Applied front-to-back, the second edit would land two characters
   * late and the result would be garbage — which is exactly what a naive
   * implementation produces and what a single-edit test never catches.
   */
  it('applies edits from the end backwards, whatever order they arrive in', () => {
    const source = 'x = x + x\n'
    const edits = [edit(1, 1, 1, 2, 'renamed'), edit(1, 5, 1, 6, 'renamed'), edit(1, 9, 1, 10, 'renamed')]

    expect(applyTextEdits(source, edits)).toEqual({
      ok: true,
      text: 'renamed = renamed + renamed\n'
    })
    // Same answer from the reverse order, because the sort is the mechanism
    // rather than the caller's discipline.
    expect(applyTextEdits(source, [...edits].reverse())).toEqual({
      ok: true,
      text: 'renamed = renamed + renamed\n'
    })
  })

  it('spans lines', () => {
    const source = 'const a = {\n  x: 1\n}\n'
    expect(applyTextEdits(source, [edit(1, 11, 3, 2, '{ x: 2 }')])).toEqual({
      ok: true,
      text: 'const a = { x: 2 }\n'
    })
  })

  it('inserts at a zero-width range', () => {
    expect(applyTextEdits('let x\n', [edit(1, 6, 1, 6, ' = 1')])).toEqual({
      ok: true,
      text: 'let x = 1\n'
    })
  })

  it('deletes', () => {
    expect(applyTextEdits('let  x = 1\n', [edit(1, 4, 1, 5, '')])).toEqual({
      ok: true,
      text: 'let x = 1\n'
    })
  })

  it('allows two edits that touch without overlapping', () => {
    // Adjacent replacements are not a conflict, so the overlap check has to be
    // strict — rejecting these would refuse ordinary renames of `a.b`.
    expect(applyTextEdits('ab\n', [edit(1, 1, 1, 2, 'X'), edit(1, 2, 1, 3, 'Y')])).toEqual({
      ok: true,
      text: 'XY\n'
    })
  })

  describe('refuses rather than guesses', () => {
    it('rejects overlapping edits and changes nothing', () => {
      const result = applyTextEdits('abcdef\n', [
        edit(1, 1, 1, 4, 'X'),
        edit(1, 3, 1, 6, 'Y')
      ])
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.reason).toContain('overlap')
    })

    it('rejects a range past the end of the file', () => {
      const result = applyTextEdits('short\n', [edit(9, 1, 9, 2, 'X')])
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.reason).toContain('outside the file')
    })

    it('rejects a column past the end of its line', () => {
      // The file changed under the caller: the range describes a longer line
      // than the one that is here. Applying it would clamp silently into the
      // next line's text.
      const result = applyTextEdits('ab\ncd\n', [edit(1, 1, 1, 40, 'X')])
      expect(result.ok).toBe(false)
    })

    it('rejects a range that ends before it begins', () => {
      const result = applyTextEdits('abcdef\n', [edit(1, 4, 1, 2, 'X')])
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.reason).toContain('ends before')
    })
  })

  it('handles CRLF without special-casing it', () => {
    // `\r` belongs to the line it terminates, so only `\n` starts a new one —
    // which means a column on a CRLF line counts the `\r`, exactly as Monaco
    // does. Getting this wrong shifts every edit on Windows by one per line.
    const source = 'let x = 1\r\nlet y = 2\r\n'
    expect(applyTextEdits(source, [edit(2, 5, 2, 6, 'z')])).toEqual({
      ok: true,
      text: 'let x = 1\r\nlet z = 2\r\n'
    })
  })

  it('edits the last line when the file has no trailing newline', () => {
    expect(applyTextEdits('a\nb', [edit(2, 1, 2, 2, 'z')])).toEqual({ ok: true, text: 'a\nz' })
  })
})

describe('editedPaths', () => {
  it('deduplicates, keeping first-seen order', () => {
    expect(
      editedPaths([
        { relativePath: 'b.ts', path: '/w/b.ts', edits: [] },
        { relativePath: 'a.ts', path: '/w/a.ts', edits: [] },
        { relativePath: 'b.ts', path: '/w/b.ts', edits: [] }
      ])
    ).toEqual(['/w/b.ts', '/w/a.ts'])
  })
})
