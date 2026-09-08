import type * as monacoNs from 'monaco-editor'
import { relativePathFromUri } from './document-uri'

/**
 * Breakpoints, and the line the debugger is stopped on.
 *
 * They live with the EDITOR rather than with the debug panel because that is
 * their real lifetime: a breakpoint is set before a session starts, survives it
 * ending, and is still there for the next run. A panel that owned them would
 * lose them every time the session it belongs to did.
 *
 * ## Keyed by the workspace-relative path
 *
 * Which is what a model URI carries, what the debug session is started with,
 * and what every `stopped` message names. The absolute path is a fourth
 * spelling of the same file and would have to be translated at each of those
 * boundaries; keying by the one they all already agree on means no translation
 * and nowhere for the two to drift apart.
 *
 * ## Why the gutter and not a list
 *
 * Clicking beside a line is how every IDE sets a breakpoint, and it is the only
 * affordance that puts the dot where the user is already looking. The glyph
 * margin exists for exactly this; `monaco-setup.ts` turns it on.
 *
 * ## A dot that moved must LOOK moved
 *
 * `debug.ts` resolves a breakpoint on a comment to the next line with code and
 * reports where it went. Leaving the dot where it was clicked would be the
 * single most common way a debugger lies: the user watches execution run past a
 * solid red dot that was never really there. `applyResolved` moves it.
 */

/** Breakpoint lines per file, keyed by workspace-relative path. */
const byFile = new Map<string, Set<number>>()

const listeners = new Set<() => void>()

let editor: monacoNs.editor.IStandaloneCodeEditor | null = null
let decorations: monacoNs.editor.IEditorDecorationsCollection | null = null

/** Where execution is stopped, or null when no session is paused. */
let stoppedAt: { readonly relativePath: string; readonly line: number } | null = null

export function onBreakpointsChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function announce(): void {
  for (const listener of listeners) listener()
}

export function breakpointsFor(relativePath: string): number[] {
  return [...(byFile.get(relativePath) ?? [])].sort((a, b) => a - b)
}

export function toggleBreakpoint(relativePath: string, line: number): void {
  const lines = byFile.get(relativePath) ?? new Set<number>()
  if (lines.has(line)) lines.delete(line)
  else lines.add(line)

  if (lines.size === 0) byFile.delete(relativePath)
  else byFile.set(relativePath, lines)

  render()
  announce()
}

/**
 * Replace a file's breakpoints with where the session actually put them.
 *
 * Called with the adapter's answer, so a dot the user dropped on a comment
 * jumps to the line execution will really reach.
 *
 * Deliberately does NOT announce, and that is a loop rather than a nicety. The
 * debug view applies the resolved lines from every `stopped` message and also
 * re-sends breakpoints whenever they change; if the session's own answer
 * counted as a change, every stop would send a `setBreakpoints`, which produces
 * another stop, which applies again — forever, at IPC speed. The listeners
 * carry USER intent towards the session. An answer coming back the other way
 * is already accounted for by the snapshot that carried it.
 */
export function applyResolved(relativePath: string, lines: readonly number[]): void {
  if (lines.length === 0) byFile.delete(relativePath)
  else byFile.set(relativePath, new Set(lines))
  render()
}

export function setStoppedLine(relativePath: string | null, line: number | null): void {
  stoppedAt = relativePath === null || line === null ? null : { relativePath, line }
  render()
}

/* -------------------------------------------------------------------------- */
/*  Painting                                                                   */
/* -------------------------------------------------------------------------- */

function currentFile(): string | null {
  const uri = editor?.getModel()?.uri
  return uri === undefined ? null : relativePathFromUri(uri)
}

function render(): void {
  if (editor === null || decorations === null) return

  const model = editor.getModel()
  if (model === null) {
    decorations.clear()
    return
  }

  const showing = currentFile()
  const lineCount = model.getLineCount()
  // A file can be edited shorter while a breakpoint sits past its new end.
  // Monaco throws on a range outside the model, which would take the whole
  // render — the stopped-line highlight included — down with it.
  const inRange = (line: number): boolean => line >= 1 && line <= lineCount

  const next: monacoNs.editor.IModelDeltaDecoration[] = []

  for (const line of showing === null ? [] : [...(byFile.get(showing) ?? [])]) {
    if (!inRange(line)) continue
    next.push({
      range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
      options: { isWholeLine: false, glyphMarginClassName: 'bcc-breakpoint' }
    })
  }

  if (stoppedAt !== null && stoppedAt.relativePath === showing && inRange(stoppedAt.line)) {
    next.push({
      range: {
        startLineNumber: stoppedAt.line,
        startColumn: 1,
        endLineNumber: stoppedAt.line,
        endColumn: 1
      },
      options: {
        isWholeLine: true,
        className: 'bcc-debug-line',
        glyphMarginClassName: 'bcc-debug-arrow'
      }
    })
  }

  decorations.set(next)
}

/** Wire the gutter up. Called once, with the editor `createEditor` returned. */
export function attachBreakpoints(instance: monacoNs.editor.IStandaloneCodeEditor): void {
  editor = instance
  decorations = instance.createDecorationsCollection([])

  instance.onMouseDown((event) => {
    /*
     * The literal is `MouseTargetType.GUTTER_GLYPH_MARGIN`. Compared as a number
     * because the enum lives on the Monaco NAMESPACE, and importing that for a
     * value here would pull the editor bundle into a module that is otherwise
     * types-only — the same reason `monaco-setup.ts` keeps its runtime behind
     * `loadMonaco`.
     */
    if (event.target.type !== 2) return
    const line = event.target.position?.lineNumber
    const uri = instance.getModel()?.uri
    const relativePath = uri === undefined ? null : relativePathFromUri(uri)
    if (line === undefined || relativePath === null) return
    toggleBreakpoint(relativePath, line)
  })

  // Switching tabs changes which file's dots belong on screen.
  instance.onDidChangeModel(() => render())
  render()
}
