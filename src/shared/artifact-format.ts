/**
 * Turning a model's reply into an anchored, durable artifact.
 *
 * Pure: no node, no electron, no DOM. The store persists what this produces and
 * the panel renders it, but the parsing — the part that can silently produce a
 * plausible-looking artifact pointing at the wrong lines — is testable on its
 * own.
 *
 * The behaviour being reproduced is Antigravity's: an explanation is not a chat
 * message that scrolls away, it is an artifact that persists, cites specific
 * code, and can be commented on. Achieving that needs two things a raw markdown
 * reply does not have — a stable identity per section, so a comment can attach
 * to one, and machine-readable citations, so "this part of the explanation"
 * maps to "these lines of that file".
 *
 * The citation convention is asked for in the prompt and parsed here:
 *
 *     [[src/runner.ts:117-140]]      a range
 *     [[src/runner.ts:117]]          a single line
 *     [[src/runner.ts:117-140 planRun]]   a range with the symbol named
 *
 * Deliberately not a markdown link. A link renders as a link in any viewer and
 * would be indistinguishable from a real URL; this syntax cannot be produced by
 * accident, so a false anchor is a model error rather than an ambiguity.
 */

export interface CodeAnchor {
  readonly relativePath: string
  readonly startLine: number
  readonly endLine: number
  readonly symbol: string | null
  /**
   * Hash of the anchored lines when the artifact was written.
   *
   * The reason an artifact can be trusted a week later. If the code has moved
   * on, the anchor is marked stale rather than silently pointing at whatever
   * now occupies those line numbers — which is the failure mode of every
   * "explain this" feature that stores line numbers alone.
   */
  readonly snapshotHash: string
}

export interface ArtifactSection {
  readonly id: string
  readonly heading: string
  readonly markdown: string
  readonly anchors: readonly CodeAnchor[]
}

/** `[[path:start-end symbol]]`, with the range and symbol both optional. */
const ANCHOR_PATTERN = /\[\[([^\]:]+):(\d+)(?:-(\d+))?(?:\s+([^\]]+))?\]\]/g

/**
 * Every citation in a block of markdown, in order, deduplicated.
 *
 * `snapshotHash` is left empty here and filled in by the caller, which is the
 * only place with access to the file contents. Splitting it that way keeps this
 * module free of I/O and keeps the hashing in one place.
 */
export function parseAnchors(markdown: string): CodeAnchor[] {
  const found: CodeAnchor[] = []
  const seen = new Set<string>()

  for (const match of markdown.matchAll(ANCHOR_PATTERN)) {
    const relativePath = (match[1] ?? '').trim()
    const startLine = Number(match[2])
    // A single-line citation is a range of one, not a range with a null end.
    // Downstream code then never has to special-case it.
    const endLine = match[3] === undefined ? startLine : Number(match[3])
    const symbol = match[4]?.trim() ?? null

    if (relativePath === '' || !Number.isFinite(startLine) || startLine < 1) continue
    // A reversed range is a model slip, not a reason to drop the citation.
    const from = Math.min(startLine, endLine)
    const to = Math.max(startLine, endLine)

    const key = `${relativePath}:${from}-${to}`
    if (seen.has(key)) continue
    seen.add(key)

    found.push({ relativePath, startLine: from, endLine: to, symbol, snapshotHash: '' })
  }

  return found
}

/** Renders an anchor back to its citation form — used when re-prompting. */
export function formatAnchor(anchor: CodeAnchor): string {
  const range =
    anchor.startLine === anchor.endLine
      ? String(anchor.startLine)
      : `${anchor.startLine}-${anchor.endLine}`
  return anchor.symbol === null
    ? `[[${anchor.relativePath}:${range}]]`
    : `[[${anchor.relativePath}:${range} ${anchor.symbol}]]`
}

/** A slug safe to use as a DOM id and stable across renders of the same text. */
function slugify(heading: string, index: number): string {
  const base = heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  // The index is always included, never only-on-collision. Two sections with
  // the same heading would otherwise get ids that depend on how many earlier
  // sections happened to share it, so a comment's target would move when an
  // unrelated section above it was renamed.
  return base === '' ? `section-${index + 1}` : `${base}-${index + 1}`
}

/**
 * Splits a markdown reply into sections on its headings.
 *
 * Any prose before the first heading becomes an untitled leading section rather
 * than being dropped. Models routinely open with a sentence of summary before
 * the first `##`, and losing it would lose the most useful line in the reply.
 */
export function parseSections(markdown: string): ArtifactSection[] {
  const lines = markdown.split('\n')
  const sections: { heading: string; body: string[] }[] = []
  let current: { heading: string; body: string[] } | null = null

  for (const line of lines) {
    const heading = /^#{1,4}\s+(.*)$/.exec(line)
    if (heading !== null) {
      if (current !== null) sections.push(current)
      current = { heading: (heading[1] ?? '').trim(), body: [] }
      continue
    }
    if (current === null) current = { heading: '', body: [] }
    current.body.push(line)
  }
  if (current !== null) sections.push(current)

  return sections
    .map((section, index) => ({
      id: slugify(section.heading, index),
      heading: section.heading,
      markdown: section.body.join('\n').trim(),
      anchors: parseAnchors(section.body.join('\n'))
    }))
    // A trailing heading with no body is noise; a section with neither heading
    // nor body is nothing at all.
    .filter((section) => section.heading !== '' || section.markdown !== '')
}

/**
 * The lines an anchor points at, as they are NOW.
 *
 * Returns null when the file is shorter than the anchor expects — which is
 * itself the answer: the code the artifact described is gone.
 */
export function linesAt(content: string, startLine: number, endLine: number): string | null {
  const lines = content.split('\n')
  if (startLine > lines.length) return null
  return lines.slice(startLine - 1, Math.min(endLine, lines.length)).join('\n')
}

/**
 * A title for an artifact, derived rather than asked for.
 *
 * Asking the model to name its own document costs a round trip's worth of
 * instructions and returns something it invented. The enclosing symbol and the
 * file are what a person will actually recognise in a list a week later.
 *
 * Lives here rather than in explain-service so the renderer — which is what
 * calls `artifact:create`, because it is what accumulated the stream — names
 * artifacts by the same rule main would have.
 */
export function titleForExplanation(
  relativePath: string,
  startLine: number,
  symbolName: string | null,
  isRevision: boolean
): string {
  const subject =
    symbolName === null ? `${relativePath}:${startLine}` : `${symbolName} in ${relativePath}`
  return isRevision ? `${subject} — revised` : subject
}

export type AnchorState = 'current' | 'stale' | 'missing'

/**
 * Whether an anchor still describes what it described when it was written.
 *
 * `missing` and `stale` are kept apart on purpose. "The file no longer has
 * those lines" and "those lines say something different now" call for different
 * words in the UI, and collapsing them would tell the user less than the
 * artifact actually knows.
 */
export function anchorState(anchor: CodeAnchor, currentHash: string | null): AnchorState {
  if (currentHash === null) return 'missing'
  return currentHash === anchor.snapshotHash ? 'current' : 'stale'
}
