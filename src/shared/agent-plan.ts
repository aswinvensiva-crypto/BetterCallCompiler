/**
 * Parsing a multi-file agent answer into per-file edits.
 *
 * Pure and dependency-free, in `shared/` for the reason `workspace-edit.ts`
 * is: both main (to validate before offering an apply) and the renderer (to
 * render per-file hunks as the stream settles) need the same answer, and a
 * parser that only main can run would leave the renderer re-deriving an
 * approximation of it — the same trap `renderContext` avoids for prompts.
 *
 * ## The format
 *
 * The model is told to reply with one block per file:
 *
 *   ### FILE: src/foo.ts
 *   ```ts
 *   ...full new contents of the file...
 *   ```
 *
 * repeated for every file it touches, optionally preceded by prose (a plan
 * summary) before the first `### FILE:` marker. Full contents rather than a
 * patch — the same choice `ai:apply` already makes for a single file, and for
 * the same reason: the model does not have to get diff-hunk arithmetic right
 * for a write to be correct.
 */

export interface AgentFileEdit {
  readonly path: string
  readonly content: string
}

const FILE_MARKER = /^### FILE:\s*(.+?)\s*$/

/**
 * Text the model wrote before the first `### FILE:` marker — the plan
 * summary a walkthrough or a review would want to show. Empty string when the
 * answer opens directly with a marker.
 */
export function extractAgentSummary(answer: string): string {
  const lines = answer.split('\n')
  const markerIndex = lines.findIndex((line) => FILE_MARKER.test(line))
  if (markerIndex === -1) return answer.trim()
  return lines.slice(0, markerIndex).join('\n').trim()
}

/**
 * Splits the answer into one edit per `### FILE:` block, extracting the first
 * fenced code block under each. A marker whose block never closes, or that is
 * immediately followed by another marker with no fence between them, is
 * dropped rather than guessed at — an incomplete file in a streamed answer is
 * common while tokens are still arriving, and the caller re-parses once the
 * stream settles.
 *
 * Duplicate paths keep the LAST occurrence: a model that restates a file
 * (correcting itself mid-answer) means the correction, not the draft, is what
 * should apply.
 */
export function parseAgentPlan(answer: string): AgentFileEdit[] {
  const lines = answer.split('\n')
  const markers: { path: string; startLine: number }[] = []

  for (let i = 0; i < lines.length; i++) {
    const match = FILE_MARKER.exec(lines[i] ?? '')
    if (match?.[1] !== undefined) markers.push({ path: match[1], startLine: i })
  }

  const byPath = new Map<string, AgentFileEdit>()

  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i]
    if (marker === undefined) continue
    const nextStart = markers[i + 1]?.startLine ?? lines.length
    const block = lines.slice(marker.startLine + 1, nextStart).join('\n')

    const fence = /```[^\n]*\n([\s\S]*?)```/.exec(block)
    const body = fence?.[1]
    if (body === undefined) continue

    const content = body.replace(/\n$/, '')
    const path = normalizeAgentPath(marker.path)
    if (path === null) continue

    byPath.set(path, { path, content })
  }

  return [...byPath.values()]
}

/**
 * Rejects anything that is not a clean workspace-relative path — no leading
 * slash, no drive letter, no `..` segment. The IPC boundary re-validates this
 * independently via `confinePath`; this is the first filter, close to where
 * the untrusted text is produced, so a bad path never even reaches the
 * "review this edit" UI as something that looks appliable.
 */
export function normalizeAgentPath(raw: string): string | null {
  const trimmed = raw.trim().replace(/^[`'"]|[`'"]$/g, '')
  if (trimmed === '') return null

  const posix = trimmed.replace(/\\/g, '/')
  if (posix.startsWith('/') || /^[a-zA-Z]:/.test(posix)) return null

  const segments = posix.split('/')
  if (segments.some((segment) => segment === '..' || segment === '')) return null

  return segments.join('/')
}
