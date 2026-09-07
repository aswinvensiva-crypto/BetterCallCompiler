import { describe, expect, it } from 'vitest'
import { scoreChunks, type ScoredChunkInput } from '../../src/shared/semantic-scoring'

/** A "one-hot" vector so similarity between hand-built inputs is exact and easy to reason about. */
function axis(index: number, dimensions = 4): number[] {
  const vector = new Array(dimensions).fill(0)
  vector[index] = 1
  return vector
}

function chunk(path: string, vector: readonly number[], overrides: Partial<ScoredChunkInput> = {}): ScoredChunkInput {
  return { path, startLine: 1, endLine: 10, preview: `preview of ${path}`, vector, ...overrides }
}

describe('scoreChunks', () => {
  it('returns nothing for no chunks or a non-positive limit', () => {
    expect(scoreChunks(axis(0), [], { limit: 5, fileNeighbors: {} })).toEqual([])
    expect(scoreChunks(axis(0), [chunk('a.ts', axis(0))], { limit: 0, fileNeighbors: {} })).toEqual([])
  })

  it('ranks an exact lexical match above an unrelated one', () => {
    const chunks = [chunk('match.ts', axis(0)), chunk('other.ts', axis(1))]
    const results = scoreChunks(axis(0), chunks, { limit: 2, fileNeighbors: {} })

    expect(results[0]?.path).toBe('match.ts')
    expect(results[0]?.score).toBeCloseTo(1, 6)
    expect(results[1]?.path).toBe('other.ts')
    expect(results[1]?.score).toBeCloseTo(0, 6)
  })

  it('respects the limit', () => {
    const chunks = [chunk('a.ts', axis(0)), chunk('b.ts', axis(0)), chunk('c.ts', axis(0))]
    const results = scoreChunks(axis(0), chunks, { limit: 2, fileNeighbors: {} })
    expect(results).toHaveLength(2)
  })

  it('returns at most one chunk per file, keeping the best-scoring one', () => {
    const chunks = [
      chunk('a.ts', axis(1), { startLine: 1, endLine: 10 }),
      chunk('a.ts', axis(0), { startLine: 20, endLine: 30 })
    ]
    const results = scoreChunks(axis(0), chunks, { limit: 5, fileNeighbors: {} })
    expect(results).toHaveLength(1)
    expect(results[0]?.startLine).toBe(20)
  })

  it('boosts a weaker match that is a graph neighbor of a strong match', () => {
    // `weak` shares no vocabulary with the query at all — orthogonal vector —
    // but is a neighbor of `strong`, which matches the query exactly.
    const chunks = [
      chunk('strong.ts', axis(0)),
      chunk('weak.ts', [0.5, 0.5, 0.5, 0.5]),
      chunk('unrelated.ts', axis(2))
    ]

    const withoutNeighbors = scoreChunks(axis(0), chunks, { limit: 3, fileNeighbors: {} })
    const withNeighbors = scoreChunks(axis(0), chunks, {
      limit: 3,
      fileNeighbors: { 'weak.ts': ['strong.ts'], 'strong.ts': ['weak.ts'] }
    })

    const weakWithout = withoutNeighbors.find((entry) => entry.path === 'weak.ts')
    const weakWith = withNeighbors.find((entry) => entry.path === 'weak.ts')
    expect(weakWith?.score).toBeGreaterThan(weakWithout?.score ?? Infinity)
  })

  it('never boosts a chunk whose neighbor did not itself score well enough to be in the seed pool', () => {
    // Raw (non-unit) vectors here, so cosineSimilarity against query [1,0,0,0]
    // is exactly each chunk's first component — scores are exact, not
    // approximate, which is what makes the rank arithmetic in this test work.
    const query = [1, 0, 0, 0]
    const topFillers = Array.from({ length: 19 }, (_, i) => chunk(`top-${i}.ts`, [1, 0, 0, 0]))
    const midFillers = Array.from({ length: 60 }, (_, i) => chunk(`mid-${i}.ts`, [0.3, 0, 0, 0]))
    const weak = chunk('weak.ts', [0.5, 0, 0, 0])
    const distant = chunk('distant.ts', [0.1, 0, 0, 0])

    // Ranks: 19 top fillers (1-19), weak.ts (20), 60 mid fillers (21-80),
    // distant.ts (81, last). limit 20 -> seedSize = min(81, max(80,20)) = 80,
    // which reaches every mid filler but stops just short of distant.ts —
    // weak's only neighbor never enters the seed pool.
    const chunks = [...topFillers, weak, ...midFillers, distant]

    const results = scoreChunks(query, chunks, {
      limit: 20,
      fileNeighbors: { 'weak.ts': ['distant.ts'], 'distant.ts': ['weak.ts'] }
    })

    const weakResult = results.find((entry) => entry.path === 'weak.ts')
    expect(weakResult).toBeDefined()
    // Unboosted: exactly its raw lexical score, because its only neighbor
    // never made it into the seed pool to grant a boost.
    expect(weakResult?.score).toBeCloseTo(0.5, 6)
  })

  it('caps the proximity boost at maxProximityBoost', () => {
    const manyNeighbors = Array.from({ length: 10 }, (_, i) => `n${i}.ts`)
    const chunks = [
      chunk('center.ts', [0.5, 0.5, 0.5, 0.5]),
      ...manyNeighbors.map((path) => chunk(path, axis(0)))
    ]

    const fileNeighbors: Record<string, string[]> = { 'center.ts': manyNeighbors }
    for (const neighbor of manyNeighbors) fileNeighbors[neighbor] = ['center.ts']

    const results = scoreChunks(axis(0), chunks, { limit: 11, fileNeighbors, maxProximityBoost: 0.3 })
    const center = results.find((entry) => entry.path === 'center.ts')
    const lexical = 0.5 // dot(axis(0), [0.5,0.5,0.5,0.5])
    expect(center?.score).toBeCloseTo(lexical * 1.3, 6)
  })
})
