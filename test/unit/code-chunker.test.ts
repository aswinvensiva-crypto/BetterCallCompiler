import { describe, expect, it } from 'vitest'
import { chunkSource } from '../../src/shared/code-chunker'

describe('chunkSource', () => {
  it('returns nothing for empty or whitespace-only text', () => {
    expect(chunkSource('')).toEqual([])
    expect(chunkSource('   \n  ')).toEqual([])
  })

  it('returns one chunk for a file smaller than the window', () => {
    const text = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n')
    const chunks = chunkSource(text)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toEqual({ startLine: 1, endLine: 10, text })
  })

  it('splits a large file into overlapping windows covering every line', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`)
    const chunks = chunkSource(lines.join('\n'))

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0]?.startLine).toBe(1)
    expect(chunks[chunks.length - 1]?.endLine).toBe(200)

    // No gap: every chunk after the first starts at or before the previous
    // chunk's end, so no line is skipped by the window advancing too far.
    for (let i = 1; i < chunks.length; i++) {
      const previous = chunks[i - 1]
      const current = chunks[i]
      expect(current?.startLine).toBeLessThanOrEqual((previous?.endLine ?? 0) + 1)
    }
  })

  it('caps the number of chunks for an enormous file', () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i}`)
    const chunks = chunkSource(lines.join('\n'))
    expect(chunks.length).toBeLessThanOrEqual(25)
  })

  it('reports 1-based inclusive line numbers matching each chunk\'s text', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `L${i + 1}`)
    const chunks = chunkSource(lines.join('\n'))
    for (const chunk of chunks) {
      const expectedLineCount = chunk.endLine - chunk.startLine + 1
      expect(chunk.text.split('\n')).toHaveLength(expectedLineCount)
    }
  })
})
