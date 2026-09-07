/**
 * A local, offline stand-in for a neural text embedding.
 *
 * There is no embeddings API this app holds a key for — Anthropic's API is
 * chat completion, and Ollama's embedding endpoint would tie retrieval to
 * whichever local model happens to be pulled. Hashed term frequencies give up
 * the thing a real embedding buys (synonyms, paraphrase) in exchange for
 * something the plan's other items all prize: it works offline, it is free,
 * and it is the same answer every time, which the "provably correct" bar this
 * codebase holds everything else to needs — a network embedding call would be
 * the one piece of retrieval nobody could reproduce from the log.
 */

/** Vector width. Larger reduces hash collisions; 256 is enough for a single repo's vocabulary. */
const DIMENSIONS = 256

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2)
}

/** FNV-1a — fast, and stable across platforms, which a language-runtime hash is not guaranteed to be. */
function hashToken(token: string): number {
  let hash = 2166136261
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return Math.abs(hash) % DIMENSIONS
}

/** Hashed, L2-normalized term-frequency vector. Normalized so cosine similarity is a plain dot product. */
export function embed(text: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0)
  for (const token of tokenize(text)) {
    const bucket = hashToken(token)
    vector[bucket] = (vector[bucket] ?? 0) + 1
  }

  let normSq = 0
  for (const value of vector) normSq += value * value
  const norm = Math.sqrt(normSq)
  if (norm === 0) return vector

  return vector.map((value) => value / norm)
}

/** Plain dot product — valid as cosine similarity only because `embed` always returns unit vectors. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0)
  return dot
}

export const EMBEDDING_DIMENSIONS = DIMENSIONS
