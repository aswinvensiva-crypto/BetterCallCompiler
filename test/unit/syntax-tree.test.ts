import { describe, expect, it } from 'vitest'
import {
  controlFlowSignature,
  intersectsLines,
  supportsLanguage,
  toEdit,
  type ContentChange,
  type FlowNode
} from '../../src/renderer/editor/syntax-tree'

/**
 * The pure half of the incremental-parsing layer, tested with no WebAssembly.
 *
 * These three functions are where a mistake is silent. A wrong `toEdit` does
 * not throw — it makes tree-sitter reuse the wrong subtree, and the damage
 * surfaces later as an occasional stale graph. A wrong signature either rebuilds
 * constantly (merely slow) or never rebuilds at all (visibly broken).
 */

function change(overrides: Partial<ContentChange> = {}): ContentChange {
  return {
    rangeOffset: 10,
    rangeLength: 0,
    text: 'x',
    startLine: 2,
    startColumn: 3,
    endLine: 2,
    endColumn: 3,
    ...overrides
  }
}

function node(type: string, row: number, children: FlowNode[] = []): FlowNode {
  return { type, startPosition: { row, column: 0 }, namedChildren: children }
}

describe('toEdit', () => {
  /**
   * Monaco is 1-based in rows and columns; tree-sitter is 0-based. An off-by-one
   * here does not throw, it reuses the wrong region.
   */
  it('converts Monaco 1-based positions to tree-sitter 0-based rows', () => {
    const edit = toEdit(change({ startLine: 5, startColumn: 3, endLine: 5, endColumn: 3 }))

    expect(edit.startPosition).toEqual({ row: 4, column: 2 })
    expect(edit.oldEndPosition).toEqual({ row: 4, column: 2 })
  })

  it('derives the new end from the inserted text, not from Monaco', () => {
    // Monaco reports the range that was REPLACED and knows nothing about the
    // shape of what replaced it.
    const edit = toEdit(change({ rangeOffset: 10, rangeLength: 0, text: 'hello' }))

    expect(edit.startIndex).toBe(10)
    expect(edit.oldEndIndex).toBe(10)
    expect(edit.newEndIndex).toBe(15)
    expect(edit.newEndPosition).toEqual({ row: 1, column: 2 + 5 })
  })

  it('advances the row when the inserted text contains newlines', () => {
    const edit = toEdit(
      change({ startLine: 3, startColumn: 1, text: 'one\ntwo\nthree', rangeLength: 0 })
    )

    // Three lines inserted from row 2 lands the end on row 4, at the length of
    // the last line rather than offset from the start column.
    expect(edit.newEndPosition).toEqual({ row: 4, column: 5 })
  })

  it('handles a deletion, where the new end is the start', () => {
    const edit = toEdit(
      change({ rangeOffset: 20, rangeLength: 7, text: '', startLine: 4, startColumn: 1, endLine: 4, endColumn: 8 })
    )

    expect(edit.startIndex).toBe(20)
    expect(edit.oldEndIndex).toBe(27)
    expect(edit.newEndIndex).toBe(20)
    expect(edit.newEndPosition).toEqual({ row: 3, column: 0 })
  })

  it('handles a replacement of different length', () => {
    const edit = toEdit(change({ rangeOffset: 5, rangeLength: 10, text: 'ab' }))

    expect(edit.oldEndIndex).toBe(15)
    expect(edit.newEndIndex).toBe(7)
  })
})

describe('controlFlowSignature', () => {
  /**
   * The claim the whole optimisation rests on: an edit that cannot change the
   * diagram must not change the signature.
   */
  it('ignores nodes the graph does not draw', () => {
    const before = controlFlowSignature(
      node('program', 0, [node('function_declaration', 1, [node('identifier', 1), node('return_statement', 2)])])
    )
    // A rename: the identifier changed, nothing else did.
    const after = controlFlowSignature(
      node('program', 0, [node('function_declaration', 1, [node('string_literal', 1), node('return_statement', 2)])])
    )

    expect(after).toBe(before)
  })

  it('changes when a branch is added', () => {
    const before = controlFlowSignature(node('program', 0, [node('function_declaration', 1)]))
    const after = controlFlowSignature(
      node('program', 0, [node('function_declaration', 1, [node('if_statement', 2)])])
    )

    expect(after).not.toBe(before)
  })

  /**
   * Rows are part of the fingerprint on purpose: the graph's nodes carry source
   * locations, and clicking one jumps the editor there. Inserting a blank line
   * really does change the diagram, and a signature that ignored rows would
   * leave every click one line off.
   */
  it('changes when a construct moves to a different line', () => {
    const before = controlFlowSignature(node('program', 0, [node('if_statement', 5)]))
    const after = controlFlowSignature(node('program', 0, [node('if_statement', 6)]))

    expect(after).not.toBe(before)
  })

  /**
   * Columns are NOT included. Re-indenting moves every column and moves no
   * node, and counting it would make a reformat look structural — exactly the
   * edit this is meant to make free.
   */
  it('ignores a change in indentation', () => {
    const indented: FlowNode = {
      type: 'if_statement',
      startPosition: { row: 5, column: 0 },
      namedChildren: []
    }
    const reindented: FlowNode = {
      type: 'if_statement',
      startPosition: { row: 5, column: 8 },
      namedChildren: []
    }

    expect(controlFlowSignature(reindented)).toBe(controlFlowSignature(indented))
  })

  it('is order-sensitive, so two swapped functions differ', () => {
    const a = controlFlowSignature(
      node('program', 0, [node('function_declaration', 1), node('class_declaration', 5)])
    )
    const b = controlFlowSignature(
      node('program', 0, [node('class_declaration', 1), node('function_declaration', 5)])
    )

    expect(a).not.toBe(b)
  })

  it('walks siblings left to right regardless of the traversal stack', () => {
    const signature = controlFlowSignature(
      node('program', 0, [node('if_statement', 1), node('while_statement', 2), node('return_statement', 3)])
    )

    expect(signature).toBe('if_statement@1|while_statement@2|return_statement@3')
  })

  it('survives a null child and a null root', () => {
    expect(controlFlowSignature(null)).toBe('')
    expect(
      controlFlowSignature({
        type: 'program',
        startPosition: { row: 0, column: 0 },
        namedChildren: [null, node('if_statement', 4)]
      })
    ).toBe('if_statement@4')
  })

  /**
   * Iterative, not recursive. A deeply nested file would otherwise recurse as
   * far as its deepest block — the same lesson `stronglyConnectedComponents`
   * already learned in the daemon.
   */
  it('handles a 10 000-deep nesting without overflowing the stack', () => {
    let deepest = node('return_statement', 10_000)
    for (let row = 9_999; row >= 0; row--) deepest = node('if_statement', row, [deepest])

    expect(() => controlFlowSignature(deepest)).not.toThrow()
    expect(controlFlowSignature(deepest).split('|')).toHaveLength(10_001)
  })
})

describe('intersectsLines', () => {
  const range = (startRow: number, endRow: number) => ({
    startIndex: 0,
    endIndex: 0,
    startPosition: { row: startRow, column: 0 },
    endPosition: { row: endRow, column: 0 }
  })

  it('reports an overlap using 1-based caller lines against 0-based rows', () => {
    // Rows 4-6 are lines 5-7.
    expect(intersectsLines([range(4, 6)], 5, 7)).toBe(true)
    expect(intersectsLines([range(4, 6)], 7, 9)).toBe(true)
    expect(intersectsLines([range(4, 6)], 1, 5)).toBe(true)
  })

  it('reports no overlap when the ranges are disjoint', () => {
    expect(intersectsLines([range(4, 6)], 8, 12)).toBe(false)
    expect(intersectsLines([range(10, 12)], 1, 5)).toBe(false)
  })

  it('reports nothing for an empty change set', () => {
    expect(intersectsLines([], 1, 100)).toBe(false)
  })
})

describe('supportsLanguage', () => {
  it('recognises the shipped grammars and nothing else', () => {
    for (const id of ['typescript', 'javascript', 'typescriptreact', 'javascriptreact', 'python']) {
      expect(supportsLanguage(id)).toBe(true)
    }
    // Deliberately absent: nothing consumes a C++ tree yet, and the grammar is
    // 4.5 MB.
    for (const id of ['cpp', 'c', 'rust', 'plaintext', '']) {
      expect(supportsLanguage(id)).toBe(false)
    }
  })
})
