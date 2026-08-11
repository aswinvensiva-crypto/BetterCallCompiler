import { describe, expect, it } from 'vitest'
import { renderExplainContext, renderNeighbours } from '../../src/main/explain-service'
import { titleForExplanation } from '../../src/shared/artifact-format'
import type { AiContext, Artifact } from '../../src/shared/types'

function context(overrides: Partial<AiContext> = {}): AiContext {
  return {
    filePath: 'C:/ws/src/runner.ts',
    relativePath: 'src/runner.ts',
    languageId: 'typescript',
    selection: {
      text: 'export function planRun() {}',
      startLine: 117,
      startColumn: 1,
      endLine: 140,
      endColumn: 2
    },
    enclosingSymbol: { name: 'planRun', kind: 'function', text: 'export function planRun() {}' },
    imports: ["import { join } from 'node:path'"],
    ...overrides
  }
}

function artifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: 'ex-a-1',
    kind: 'explanation',
    title: 'planRun in src/runner.ts',
    createdAt: '2026-08-11T00:00:00.000Z',
    model: 'claude-sonnet-5',
    promptHash: 'abc',
    contextSent: '',
    sections: [
      { id: 'planning-1', heading: 'Planning', markdown: 'It picks a recipe.', anchors: [] }
    ],
    comments: [],
    supersedes: null,
    ...overrides
  }
}

describe('renderNeighbours', () => {
  /**
   * What the model actually lacks is knowing the file has dependents at all. A
   * function is explained very differently when fourteen files import it than
   * when nothing does, and that fact costs a line while the contents would cost
   * the whole budget.
   */
  it('names imports and importers in both directions', () => {
    const text = renderNeighbours(['src/a.ts', 'src/b.ts'], ['src/app.ts'])

    expect(text).toContain('This file imports: src/a.ts, src/b.ts')
    expect(text).toContain('Imported by: src/app.ts')
  })

  /**
   * "Imported by 3 files" and "imported by 200 files" call for different
   * explanations. A list silently cut to twelve reads as the former in both
   * cases, so the remainder is stated.
   */
  it('states the remainder rather than truncating silently', () => {
    const many = Array.from({ length: 40 }, (_, index) => `src/f${index}.ts`)
    const text = renderNeighbours([], many)

    expect(text).toContain('and 28 more')
    expect(text).toContain('wide fan-in')
  })

  it('says nothing at all for an isolated file', () => {
    expect(renderNeighbours([], [])).toBe('')
  })
})

describe('renderExplainContext', () => {
  /**
   * The citation syntax is only useful if the model knows which path string to
   * put in it. Without being told, it guesses at the repository layout and
   * cites paths that do not resolve.
   */
  it('tells the model exactly how to cite this file, with a worked example', () => {
    const text = renderExplainContext(context(), '', null, null)

    expect(text).toContain('Cite this file as: src/runner.ts')
    expect(text).toContain('[[src/runner.ts:117-140 planRun]]')
  })

  it('builds on renderContext so the stored prompt matches the AI panel’s', () => {
    const text = renderExplainContext(context(), '', null, null)

    // These lines come from `renderContext`, not from this module. A second
    // renderer would drift, and the "context sent" claim would become false.
    expect(text).toContain('File: src/runner.ts')
    expect(text).toContain('Language: typescript')
    expect(text).toContain('Selection: lines 117-140')
  })

  it('omits the neighbour section when there are no neighbours', () => {
    expect(renderExplainContext(context(), '', null, null)).not.toContain('import graph')
  })

  it('includes the prior explanation and the comment when revising', () => {
    const text = renderExplainContext(
      context(),
      '',
      artifact(),
      'Why does it prefer the bundled runtime?'
    )

    expect(text).toContain('The explanation you wrote earlier:')
    expect(text).toContain('## Planning')
    expect(text).toContain('It picks a recipe.')
    expect(text).toContain('Why does it prefer the bundled runtime?')
  })

  it('ignores a blank comment rather than sending an empty question', () => {
    expect(renderExplainContext(context(), '', null, '   ')).not.toContain('reader')
  })

  it('falls back to the selection line when there is no enclosing symbol', () => {
    const text = renderExplainContext(context({ enclosingSymbol: null }), '', null, null)
    expect(text).toContain('[[src/runner.ts:117-140]]')
  })
})

describe('titleForExplanation', () => {
  it('names the symbol and file, which is what a person recognises later', () => {
    expect(titleForExplanation('src/runner.ts', 117, 'planRun', false)).toBe(
      'planRun in src/runner.ts'
    )
  })

  it('falls back to file and line with no symbol', () => {
    expect(titleForExplanation('src/runner.ts', 117, null, false)).toBe('src/runner.ts:117')
  })

  /**
   * Marked in the title as well as in the record. Two similarly-named entries
   * with no way to tell which answered which is how a history stops being
   * usable.
   */
  it('marks a revision', () => {
    expect(titleForExplanation('src/runner.ts', 117, 'planRun', true)).toBe(
      'planRun in src/runner.ts — revised'
    )
  })
})
