/**
 * `file:line[:col]` extraction from compiler and runtime output.
 *
 * This lives in `shared/` rather than `main/` — where the target layout puts it
 * — because both sides need the same regexes and neither can own them. Main
 * cannot: xterm asks for links one *rendered* buffer line at a time, long after
 * the chunk boundaries main saw. The renderer cannot be the only owner either,
 * since main resolves and confines the paths before anything is clickable.
 * Keeping one pure, dependency-free module is what stops the two from drifting
 * into disagreeing about what counts as a location.
 *
 * Nothing here may import node or electron: it is bundled into the renderer.
 */

export interface ErrorLink {
  /** Path exactly as the tool printed it — absolute or workspace-relative. */
  readonly path: string
  /** 1-based. */
  readonly line: number
  /** 1-based, or null when the tool reported no column. */
  readonly column: number | null
  /** Character offset of the match within the line, for xterm link ranges. */
  readonly start: number
  /** Exclusive end offset. */
  readonly end: number
}

/**
 * A path fragment. Deliberately permissive about spaces — `C:\Program Files\…`
 * is normal on Windows — and deliberately strict about the characters that
 * would swallow the `:line:col` suffix we are anchored on.
 */
const PATH = String.raw`[^\s()<>"'*?|]+(?:[ \t][^\s()<>"'*?|]+)*`

interface Matcher {
  readonly id: string
  readonly pattern: RegExp
  /** Capture-group indices. */
  readonly groups: { path: number; line: number; column: number | null }
}

/**
 * Order matters only for overlap resolution below; each matcher is otherwise
 * independent. Every pattern is anchored on something structural — `at `,
 * `File "`, a diagnostic keyword — rather than on "looks like a path", because
 * an unanchored path regex matches prose and turns ordinary log lines into a
 * field of dead links.
 */
const MATCHERS: readonly Matcher[] = [
  // Node stack frame with a parenthesised location:
  //   at Object.<anonymous> (C:\app\index.js:3:9)
  {
    id: 'node-frame-parens',
    pattern: new RegExp(String.raw`\((${PATH}):(\d+):(\d+)\)`, 'g'),
    groups: { path: 1, line: 2, column: 3 }
  },
  // Node stack frame without parentheses:
  //   at C:\app\index.js:3:9
  {
    id: 'node-frame-bare',
    pattern: new RegExp(String.raw`\bat\s+(${PATH}):(\d+):(\d+)(?=\s|$)`, 'g'),
    groups: { path: 1, line: 2, column: 3 }
  },
  // The header Node prints above an uncaught throw — path and line, no column:
  //   C:\app\index.js:3
  {
    id: 'node-throw-header',
    pattern: new RegExp(String.raw`^(${PATH}\.[cm]?[jt]sx?):(\d+)$`, 'gi'),
    groups: { path: 1, line: 2, column: null }
  },
  // Python traceback frame:
  //   File "C:\app\main.py", line 3, in <module>
  {
    id: 'python-frame',
    pattern: /^\s*File "(.+?)", line (\d+)/gm,
    groups: { path: 1, line: 2, column: null }
  },
  // GCC/Clang diagnostic with a column:
  //   main.c:5:12: error: 'x' undeclared
  {
    id: 'gcc-diagnostic',
    pattern: new RegExp(
      String.raw`(?:^|\s)(${PATH}):(\d+):(\d+):\s+(?:fatal\s+error|error|warning|note)\b`,
      'g'
    ),
    groups: { path: 1, line: 2, column: 3 }
  },
  // GCC diagnostic without a column, and linker messages:
  //   main.c:5: error: ...
  {
    id: 'gcc-diagnostic-no-column',
    pattern: new RegExp(
      String.raw`(?:^|\s)(${PATH}):(\d+):\s+(?:fatal\s+error|error|warning|note)\b`,
      'g'
    ),
    groups: { path: 1, line: 2, column: null }
  },
  // tsc, which uses parentheses rather than colons:
  //   src/main.ts(10,5): error TS2304: Cannot find name 'x'.
  {
    id: 'tsc-diagnostic',
    pattern: new RegExp(String.raw`(${PATH})\((\d+),(\d+)\):\s+(?:error|warning)\b`, 'g'),
    groups: { path: 1, line: 2, column: 3 }
  }
]

function toNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const value = Number.parseInt(raw, 10)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

/**
 * Rejects locations that parse cleanly but do not name a file on disk.
 *
 * Every Node stack trace is mostly `node:internal/modules/cjs/loader:1554:14`
 * frames, and Python's is seeded with `<frozen importlib._bootstrap>`. Both
 * match the shape of a location perfectly. Linking them produces a console full
 * of clickable text that opens nothing, which trains the user to stop clicking
 * the links that do work.
 */
export function isLinkablePath(path: string): boolean {
  if (path === '') return false
  // Node builtins, old and new spelling.
  if (/^node:/i.test(path) || /^internal[\\/]/i.test(path)) return false
  // Synthetic frames: <anonymous>, <stdin>, <frozen importlib._bootstrap>.
  if (path.startsWith('<')) return false
  if (/^(?:eval|native|unknown)$/i.test(path)) return false
  return true
}

/**
 * Every location referenced by one line of output, left to right.
 *
 * Overlapping matches are resolved by preferring the one that starts earliest,
 * then the longer one. Without that, `at foo (a.js:1:2)` yields both the
 * parenthesised and the bare frame match and xterm renders two links on top of
 * each other, the shorter of which points at a truncated path.
 */
export function findErrorLinks(line: string): ErrorLink[] {
  const found: ErrorLink[] = []

  for (const matcher of MATCHERS) {
    // Fresh regex per call: a module-level /g regex carries `lastIndex` between
    // calls and would skip matches on every other line.
    const pattern = new RegExp(matcher.pattern.source, matcher.pattern.flags)
    let match: RegExpExecArray | null

    while ((match = pattern.exec(line)) !== null) {
      // A zero-length match would spin forever.
      if (match[0] === '') {
        pattern.lastIndex += 1
        continue
      }

      const rawPath = match[matcher.groups.path]
      const lineNumber = toNumber(match[matcher.groups.line])
      if (rawPath === undefined || lineNumber === null) continue
      if (!isLinkablePath(rawPath)) continue

      const column =
        matcher.groups.column === null ? null : toNumber(match[matcher.groups.column])

      // Anchor the highlight on the path itself, not on the whole diagnostic —
      // the user clicks a location, not a sentence.
      const pathOffset = match[0].indexOf(rawPath)
      const start = match.index + (pathOffset < 0 ? 0 : pathOffset)

      const suffix = column === null ? `:${lineNumber}` : `:${lineNumber}:${column}`
      const tail = matcher.id === 'tsc-diagnostic' ? `(${lineNumber},${column})` : suffix

      found.push({
        path: rawPath,
        line: lineNumber,
        column,
        start,
        end: start + rawPath.length + tail.length
      })
    }
  }

  found.sort((a, b) => (a.start === b.start ? b.end - a.end : a.start - b.start))

  const kept: ErrorLink[] = []
  let consumedTo = -1
  for (const link of found) {
    if (link.start < consumedTo) continue
    kept.push(link)
    consumedTo = link.end
  }

  return kept
}

/** True when a path the tool printed is already absolute. */
export function isAbsoluteLike(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\\\')
}
