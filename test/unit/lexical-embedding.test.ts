import { describe, expect, it } from 'vitest'
import { cosineSimilarity, embed, EMBEDDING_DIMENSIONS } from '../../src/shared/lexical-embedding'

describe('embed', () => {
  it('returns a vector of the fixed dimension', () => {
    expect(embed('hello world')).toHaveLength(EMBEDDING_DIMENSIONS)
  })

  it('returns a unit vector for non-empty text', () => {
    const vector = embed('retry policy backoff jitter')
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
    expect(norm).toBeCloseTo(1, 6)
  })

  it('returns the zero vector for empty or whitespace-only text', () => {
    expect(embed('')).toEqual(new Array(EMBEDDING_DIMENSIONS).fill(0))
    expect(embed('   ')).toEqual(new Array(EMBEDDING_DIMENSIONS).fill(0))
  })

  it('is case-insensitive', () => {
    expect(embed('RetryPolicy')).toEqual(embed('retrypolicy'))
  })

  it('ignores punctuation as a separator, not as content', () => {
    expect(embed('retry-policy')).toEqual(embed('retry policy'))
  })

  it('is deterministic', () => {
    expect(embed('the same text twice')).toEqual(embed('the same text twice'))
  })
})

describe('cosineSimilarity', () => {
  it('is 1 for identical text', () => {
    const vector = embed('exponential backoff with jitter')
    expect(cosineSimilarity(vector, vector)).toBeCloseTo(1, 6)
  })

  it('is higher for text sharing vocabulary than for unrelated text', () => {
    const query = embed('retry policy exponential backoff')
    const related = embed('the retry policy uses exponential backoff with jitter')
    const unrelated = embed('render the sidebar and activity bar icons')

    expect(cosineSimilarity(query, related)).toBeGreaterThan(cosineSimilarity(query, unrelated))
  })

  it('is 0 between disjoint vocabularies (barring hash collisions)', () => {
    const a = embed('alpha bravo charlie delta echo foxtrot golf')
    const b = embed('render sidebar toolbar statusbar activitybar panelbar')
    // Not asserted exactly 0: a 256-wide hash can collide. Asserted small.
    expect(cosineSimilarity(a, b)).toBeLessThan(0.3)
  })

  it('is 0 when either vector is the zero vector', () => {
    const zero = embed('')
    const nonzero = embed('something')
    expect(cosineSimilarity(zero, nonzero)).toBe(0)
  })
})
