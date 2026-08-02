import { describe, expect, it } from 'vitest'
import { fuzzyMatch, highlightSegments, rankFuzzy } from '../../src/renderer/workbench/fuzzy'

/**
 * The ranking *is* the experience of Ctrl+P. "The file I wanted was third" is
 * not something anyone notices by clicking around, so it is pinned here.
 */

describe('matching', () => {
  it('matches a subsequence, not just a substring', () => {
    expect(fuzzyMatch('sri', 'src/renderer/index.ts')).not.toBeNull()
    expect(fuzzyMatch('abc', 'a-b-c')).not.toBeNull()
  })

  it('rejects when a character is missing or out of order', () => {
    expect(fuzzyMatch('xyz', 'src/index.ts')).toBeNull()
    expect(fuzzyMatch('cba', 'abc')).toBeNull()
  })

  it('is case-insensitive', () => {
    expect(fuzzyMatch('RUN', 'views/run.ts')).not.toBeNull()
    expect(fuzzyMatch('run', 'views/RUN.ts')).not.toBeNull()
  })

  it('treats an empty query as matching everything, with no highlight', () => {
    const match = fuzzyMatch('', 'anything')
    expect(match?.positions).toEqual([])
  })

  it('reports the positions it matched, for highlighting', () => {
    const match = fuzzyMatch('ac', 'abc')
    expect(match?.positions).toEqual([0, 2])
  })

  it('ignores spaces so a query can be typed in parts', () => {
    expect(fuzzyMatch('src run', 'src/views/run.ts')).not.toBeNull()
  })
})

describe('ranking', () => {
  function order(query: string, candidates: readonly string[]): string[] {
    return rankFuzzy(query, candidates, (candidate) => candidate).map((ranked) => ranked.item)
  }

  it('prefers a word start over a match in the middle', () => {
    expect(order('run', ['src/overrun.ts', 'src/run.ts'])[0]).toBe('src/run.ts')
  })

  it('prefers consecutive characters over scattered ones', () => {
    expect(order('index', ['i/n/d/e/x.ts', 'index.ts'])[0]).toBe('index.ts')
  })

  it('prefers the shorter path when both match equally well', () => {
    expect(order('app', ['app.ts', 'application.test.ts'])[0]).toBe('app.ts')
  })

  it('finds a nested file by a fragment of its directory', () => {
    const files = ['src/main/ipc.ts', 'src/renderer/views/run.ts', 'test/unit/run.test.ts']
    expect(order('viewsrun', files)[0]).toBe('src/renderer/views/run.ts')
  })

  it('drops candidates that do not match at all', () => {
    expect(order('zzz', ['a.ts', 'b.ts'])).toEqual([])
  })

  // A list that reshuffles between keystrokes is how users open the wrong file.
  it('is stable for equal scores', () => {
    const candidates = ['b/x.ts', 'a/x.ts']
    expect(order('x', candidates)).toEqual(order('x', candidates))
  })

  it('honours the limit', () => {
    const many = Array.from({ length: 500 }, (_value, index) => `file${index}.ts`)
    expect(rankFuzzy('file', many, (name) => name, 10)).toHaveLength(10)
  })
})

describe('highlight segmentation', () => {
  it('splits into matched and unmatched runs', () => {
    expect(highlightSegments('abc', [0, 2])).toEqual([
      { text: 'a', matched: true },
      { text: 'b', matched: false },
      { text: 'c', matched: true }
    ])
  })

  it('merges adjacent matched characters into one run', () => {
    expect(highlightSegments('abc', [0, 1])).toEqual([
      { text: 'ab', matched: true },
      { text: 'c', matched: false }
    ])
  })

  it('returns the whole string unmatched when nothing matched', () => {
    expect(highlightSegments('abc', [])).toEqual([{ text: 'abc', matched: false }])
  })

  // The segments are rendered as text nodes precisely so this can never become
  // markup — these strings are file names off the user's disk.
  it('never loses or reorders characters', () => {
    const text = 'src/<b>weird</b>&name.ts'
    const match = fuzzyMatch('sname', text)
    const rebuilt = highlightSegments(text, match?.positions ?? [])
      .map((segment) => segment.text)
      .join('')
    expect(rebuilt).toBe(text)
  })
})
