import { describe, expect, it } from 'vitest'
import {
  anchorState,
  formatAnchor,
  linesAt,
  parseAnchors,
  parseSections,
  type CodeAnchor
} from '../../src/shared/artifact-format'

function anchor(overrides: Partial<CodeAnchor> = {}): CodeAnchor {
  return {
    relativePath: 'src/a.ts',
    startLine: 1,
    endLine: 2,
    symbol: null,
    snapshotHash: 'abc123',
    ...overrides
  }
}

describe('parseAnchors', () => {
  it('reads a range, a single line, and a named symbol', () => {
    const found = parseAnchors(
      'See [[src/runner.ts:117-140]] and [[src/ipc.ts:12]] and [[src/fs.ts:5-9 confinePath]].'
    )

    expect(found).toHaveLength(3)
    expect(found[0]).toMatchObject({ relativePath: 'src/runner.ts', startLine: 117, endLine: 140 })
    // A single-line citation becomes a range of one, so nothing downstream has
    // to special-case a null end.
    expect(found[1]).toMatchObject({ startLine: 12, endLine: 12 })
    expect(found[2]?.symbol).toBe('confinePath')
  })

  it('deduplicates repeated citations of the same range', () => {
    const found = parseAnchors('[[a.ts:1-2]] blah [[a.ts:1-2]]')
    expect(found).toHaveLength(1)
  })

  it('repairs a reversed range rather than dropping the citation', () => {
    expect(parseAnchors('[[a.ts:20-10]]')[0]).toMatchObject({ startLine: 10, endLine: 20 })
  })

  it('ignores malformed citations', () => {
    expect(parseAnchors('[[a.ts]] [[:12]] [[a.ts:0]] [[a.ts:abc]] plain text')).toEqual([])
  })

  /**
   * The reason the syntax is not a markdown link: a link is indistinguishable
   * from a real URL a model might legitimately produce, so a false anchor would
   * be an ambiguity rather than an error.
   */
  it('does not treat markdown links as anchors', () => {
    expect(parseAnchors('[see the docs](https://example.com/a.ts:12)')).toEqual([])
  })

  it('round-trips through formatAnchor', () => {
    for (const original of [
      anchor({ startLine: 5, endLine: 9, symbol: 'confinePath' }),
      anchor({ startLine: 12, endLine: 12, symbol: null })
    ]) {
      const [reparsed] = parseAnchors(formatAnchor(original))
      expect(reparsed).toMatchObject({
        relativePath: original.relativePath,
        startLine: original.startLine,
        endLine: original.endLine,
        symbol: original.symbol
      })
    }
  })
})

describe('parseSections', () => {
  it('splits on headings and collects each section’s anchors', () => {
    const sections = parseSections(
      ['## What it does', 'Runs the thing. [[a.ts:1-3]]', '', '## Edge cases', 'Fails on null. [[b.ts:9]]'].join('\n')
    )

    expect(sections).toHaveLength(2)
    expect(sections[0]?.heading).toBe('What it does')
    expect(sections[0]?.anchors[0]?.relativePath).toBe('a.ts')
    expect(sections[1]?.anchors[0]?.startLine).toBe(9)
  })

  /**
   * Models routinely open with a sentence of summary before the first heading.
   * Dropping it would lose the most useful line in the reply.
   */
  it('keeps prose that appears before the first heading', () => {
    const sections = parseSections('A one-line summary.\n\n## Details\nMore.')

    expect(sections).toHaveLength(2)
    expect(sections[0]?.heading).toBe('')
    expect(sections[0]?.markdown).toBe('A one-line summary.')
  })

  it('handles a reply with no headings at all', () => {
    const sections = parseSections('Just a paragraph.')
    expect(sections).toHaveLength(1)
    expect(sections[0]?.markdown).toBe('Just a paragraph.')
  })

  /**
   * Ids always carry their index, never only on collision. Otherwise two
   * sections sharing a heading get ids that depend on how many earlier sections
   * happened to share it — so renaming an unrelated section above would move a
   * comment's target.
   */
  it('gives stable distinct ids to sections with the same heading', () => {
    const sections = parseSections('## Notes\nfirst\n\n## Notes\nsecond')
    const ids = sections.map((section) => section.id)

    expect(new Set(ids).size).toBe(2)
    expect(ids).toEqual(['notes-1', 'notes-2'])
  })

  it('falls back to a positional id for an unnamed section', () => {
    expect(parseSections('no heading here')[0]?.id).toBe('section-1')
  })

  it('drops a trailing heading with no body', () => {
    const sections = parseSections('## Real\nbody\n\n## ')
    expect(sections).toHaveLength(1)
  })
})

describe('linesAt', () => {
  const content = 'one\ntwo\nthree\nfour'

  it('slices an inclusive 1-based range', () => {
    expect(linesAt(content, 2, 3)).toBe('two\nthree')
  })

  it('clamps an end past the last line rather than padding', () => {
    expect(linesAt(content, 3, 99)).toBe('three\nfour')
  })

  it('answers null when the file no longer reaches the start line', () => {
    expect(linesAt(content, 99, 100)).toBeNull()
  })
})

describe('anchorState', () => {
  /**
   * `missing` and `stale` stay apart. "Those lines are gone" and "those lines
   * say something else now" need different words in the UI, and merging them
   * tells the user less than the artifact knows.
   */
  it('distinguishes current, stale and missing', () => {
    expect(anchorState(anchor({ snapshotHash: 'abc' }), 'abc')).toBe('current')
    expect(anchorState(anchor({ snapshotHash: 'abc' }), 'def')).toBe('stale')
    expect(anchorState(anchor({ snapshotHash: 'abc' }), null)).toBe('missing')
  })
})
