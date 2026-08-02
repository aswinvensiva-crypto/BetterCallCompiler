/**
 * Subsequence fuzzy matching, as quick open and the command palette use it.
 *
 * Pure and import-free so it can be unit tested directly — the ranking is the
 * whole user experience of `Ctrl+P`, and "the right file is third" is not
 * something you notice by clicking around.
 */

export interface FuzzyMatch {
  readonly score: number
  /** Indices in the candidate that matched, for highlighting. */
  readonly positions: readonly number[]
}

/**
 * Bonuses and penalties.
 *
 * `CONSECUTIVE` outweighs `WORD_START` deliberately. With them the other way
 * round, a path made entirely of separators scores a word-start bonus on every
 * single character and beats the obvious answer — `i/n/d/e/x.ts` outranked
 * `index.ts` for the query "index", which is exactly the kind of ranking bug
 * nobody notices until they have opened the wrong file three times.
 */
const SCORE_EXACT_WORD_START = 12
const SCORE_CAMEL_BOUNDARY = 10
const SCORE_CONSECUTIVE = 16
const SCORE_MATCH = 2
const PENALTY_GAP = 1
const PENALTY_LEADING = 2
/** Never let a long path outrank a short one purely by having more characters. */
const MAX_LEADING_PENALTY = 12

function isWordStart(candidate: string, index: number): boolean {
  if (index === 0) return true
  const previous = candidate[index - 1]
  if (previous === undefined) return true
  return previous === '/' || previous === '\\' || previous === '_' || previous === '-' || previous === '.' || previous === ' '
}

function isCamelBoundary(candidate: string, index: number): boolean {
  const current = candidate[index]
  const previous = candidate[index - 1]
  if (current === undefined || previous === undefined) return false
  return current === current.toUpperCase() && previous === previous.toLowerCase()
}

/**
 * Scores `query` against `candidate`, or returns null when it does not match.
 *
 * Greedy left-to-right: the first position that matches each query character
 * wins. A full optimal alignment would score a handful of pathological cases
 * better and costs O(n·m) per candidate on every keystroke across every file in
 * the workspace, which is the wrong trade for a picker.
 */
export function fuzzyMatch(query: string, candidate: string): FuzzyMatch | null {
  if (query === '') return { score: 0, positions: [] }
  if (candidate === '') return null

  const lowerQuery = query.toLowerCase()
  const lowerCandidate = candidate.toLowerCase()

  const positions: number[] = []
  let score = 0
  let candidateIndex = 0
  let previousMatch = -1

  for (const char of lowerQuery) {
    // Spaces in a query separate terms; they should not have to match.
    if (char === ' ') continue

    const found = lowerCandidate.indexOf(char, candidateIndex)
    if (found === -1) return null

    if (previousMatch === -1) {
      score -= Math.min(found * PENALTY_LEADING, MAX_LEADING_PENALTY)
    } else {
      const gap = found - previousMatch - 1
      score -= Math.min(gap * PENALTY_GAP, 8)
      if (gap === 0) score += SCORE_CONSECUTIVE
    }

    if (isWordStart(candidate, found)) score += SCORE_EXACT_WORD_START
    else if (isCamelBoundary(candidate, found)) score += SCORE_CAMEL_BOUNDARY
    score += SCORE_MATCH

    positions.push(found)
    previousMatch = found
    candidateIndex = found + 1
  }

  // Shorter candidates win ties: `app.ts` should beat `application.test.ts`.
  score -= Math.floor(candidate.length / 12)

  return { score, positions }
}

export interface Ranked<T> {
  readonly item: T
  readonly score: number
  readonly positions: readonly number[]
}

/**
 * Filters and ranks, best first.
 *
 * Ties break on the candidate string so the order is stable between keystrokes
 * — a list that reshuffles under the cursor is how users pick the wrong file.
 */
export function rankFuzzy<T>(
  query: string,
  items: readonly T[],
  toText: (item: T) => string,
  limit = 200
): Array<Ranked<T>> {
  const ranked: Array<Ranked<T> & { text: string }> = []

  for (const item of items) {
    const text = toText(item)
    const match = fuzzyMatch(query, text)
    if (match === null) continue
    ranked.push({ item, text, score: match.score, positions: match.positions })
  }

  ranked.sort((a, b) => (a.score === b.score ? a.text.localeCompare(b.text) : b.score - a.score))
  return ranked.slice(0, limit).map(({ item, score, positions }) => ({ item, score, positions }))
}

/**
 * Splits a string into matched and unmatched runs for highlighting.
 *
 * Returns segments rather than HTML so the caller builds text nodes — the
 * candidate is a filename from disk and must never reach `innerHTML`.
 */
export function highlightSegments(
  text: string,
  positions: readonly number[]
): Array<{ text: string; matched: boolean }> {
  if (positions.length === 0) return [{ text, matched: false }]

  const flags = new Set(positions)
  const segments: Array<{ text: string; matched: boolean }> = []
  let current = ''
  let currentMatched = flags.has(0)

  for (let i = 0; i < text.length; i += 1) {
    const matched = flags.has(i)
    if (matched !== currentMatched) {
      if (current !== '') segments.push({ text: current, matched: currentMatched })
      current = ''
      currentMatched = matched
    }
    current += text[i] ?? ''
  }
  if (current !== '') segments.push({ text: current, matched: currentMatched })

  return segments
}
