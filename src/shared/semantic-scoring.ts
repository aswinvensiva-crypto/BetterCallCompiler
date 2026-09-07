import { cosineSimilarity } from './lexical-embedding'

/**
 * Ranking retrieval candidates: semantic (lexical) similarity combined with
 * import-graph proximity.
 *
 * Pure and separated from `semantic-index.ts` on purpose — that module reads
 * files and writes the on-disk index; this is the algorithm the plan actually
 * asks for ("score candidates using semantic similarity combined with AST
 * graph proximity"), and it deserves tests that construct hand-built vectors
 * and a hand-built neighbor map rather than exercising it only through a
 * built index on real files.
 *
 * ## The two-pass shape
 *
 * A pure proximity score (no lexical term) would happily surface a file that
 * shares no vocabulary with the instruction just because it sits next to one
 * that does — useless on its own. So proximity is a BOOST applied to lexical
 * scores, computed only among each other's seed set: a chunk's neighbors have
 * to have themselves scored well lexically for the boost to fire. That is
 * what keeps a strong lexical match from a distant, unrelated file from
 * being buried under semi-related ones a popular file happens to import.
 */

export interface ScoredChunkInput {
  readonly path: string
  readonly startLine: number
  readonly endLine: number
  readonly preview: string
  readonly vector: readonly number[]
}

export interface SemanticMatch {
  readonly path: string
  readonly startLine: number
  readonly endLine: number
  readonly preview: string
  readonly score: number
}

export interface ScoreChunksOptions {
  readonly limit: number
  /** File path -> its import-graph neighbors (see `buildNeighborMap`). */
  readonly fileNeighbors: Readonly<Record<string, readonly string[]>>
  /** How much a fully-connected chunk's score can grow. 0.3 = up to +30%. */
  readonly maxProximityBoost?: number
}

/**
 * Scores every chunk against the query vector, re-ranks the top candidates by
 * import-graph proximity to each other, and returns at most one chunk per
 * file — a second window from a file already recommended tells the caller
 * nothing a first one did not.
 */
export function scoreChunks(
  queryVector: readonly number[],
  chunks: readonly ScoredChunkInput[],
  options: ScoreChunksOptions
): SemanticMatch[] {
  if (chunks.length === 0 || options.limit <= 0) return []

  const maxBoost = options.maxProximityBoost ?? 0.3

  const lexicallyScored = chunks
    .map((chunk) => ({ chunk, lexical: cosineSimilarity(queryVector, chunk.vector) }))
    .sort((a, b) => b.lexical - a.lexical)

  // The proximity pass only ever looks within a seed pool wider than what
  // will actually be returned — large enough that a chunk's neighbor can be
  // in it, small enough that a weak, unrelated match cannot ride a popular
  // neighbor's coattails into the results.
  const seedSize = Math.min(lexicallyScored.length, Math.max(options.limit * 4, 20))
  const seed = lexicallyScored.slice(0, seedSize)
  const seedFiles = new Set(seed.map((entry) => entry.chunk.path))

  const rescored = seed.map((entry) => {
    const neighbors = options.fileNeighbors[entry.chunk.path] ?? []
    const connectedNeighbors = neighbors.filter((neighbor) => seedFiles.has(neighbor)).length
    const boost = connectedNeighbors === 0 ? 0 : Math.min(maxBoost, connectedNeighbors * 0.08)
    return { chunk: entry.chunk, score: entry.lexical * (1 + boost) }
  })

  rescored.sort((a, b) => b.score - a.score)

  const seenFiles = new Set<string>()
  const results: SemanticMatch[] = []
  for (const entry of rescored) {
    if (seenFiles.has(entry.chunk.path)) continue
    seenFiles.add(entry.chunk.path)
    results.push({
      path: entry.chunk.path,
      startLine: entry.chunk.startLine,
      endLine: entry.chunk.endLine,
      preview: entry.chunk.preview,
      score: entry.score
    })
    if (results.length >= options.limit) break
  }

  return results
}
