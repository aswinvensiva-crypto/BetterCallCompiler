/**
 * Splitting a file into retrieval-sized pieces.
 *
 * Fixed-size sliding windows rather than a per-language AST split: BCC,
 * TypeScript, Python and everything else this workspace holds would each need
 * their own boundary detector to chunk "by function", and the daemon that
 * already parses TypeScript correctly is a compiler, not a chunker — asking
 * it to segment every indexed file would mean paying a full-workspace parse
 * for a scoring pass, not the query the daemon exists to answer. A line
 * window is a coarser unit, but it is a fine one for "does this region talk
 * about X" — which is all retrieval scoring asks of a chunk.
 */

export interface CodeChunk {
  /** 1-based, inclusive. */
  readonly startLine: number
  readonly endLine: number
  readonly text: string
}

const CHUNK_LINES = 60
const OVERLAP_LINES = 10
/** Caps a single enormous file from dominating the index with hundreds of windows. */
const MAX_CHUNKS_PER_FILE = 25

export function chunkSource(text: string): CodeChunk[] {
  if (text.trim() === '') return []
  const lines = text.split('\n')

  const chunks: CodeChunk[] = []
  let start = 0

  while (start < lines.length && chunks.length < MAX_CHUNKS_PER_FILE) {
    const end = Math.min(start + CHUNK_LINES, lines.length)
    chunks.push({
      startLine: start + 1,
      endLine: end,
      text: lines.slice(start, end).join('\n')
    })
    if (end >= lines.length) break
    start = end - OVERLAP_LINES
  }

  return chunks
}
