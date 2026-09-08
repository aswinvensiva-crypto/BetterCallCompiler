import type * as monacoNs from 'monaco-editor'
import { documentUri, relativePathFromUri } from './document-uri'
import { monacoRuntime } from './monaco-setup'

/**
 * Breakpoint gutter and the current-execution-line marker.
 *
 * Breakpoints are stored per model, exactly like `markers.ts`'s diagnostics —
 * a `deltaDecorations` call against the MODEL rather than the editor, so a
 * breakpoint set in a file survives switching away from it and back, the same
 * way undo history does. They are session-only: nothing here reads or writes
 * `settings.ts`, which keeps the scope to what a debug session actually
 * needs rather than a second persistence story to keep in step with the
 * first.
 *
 * The source of truth for whether a breakpoint actually took is
 * `dap-service.ts`, not this file. A click updates the gutter immediately —
 * VS Code does the same — but the dot is drawn hollow until the adapter's
 * answer comes back `verified: true`; see `dap-protocol.ts`'s own note on
 * why that flag is never defaulted the optimistic way.
 */

const linesByPath = new Map<string, Set<number>>()
const verifiedByPath = new Map<string, Map<number, boolean>>()
const decorationIdsByPath = new Map<string, string[]>()

let editorRef: monacoNs.editor.IStandaloneCodeEditor | null = null
let currentLineDecorationIds: string[] = []
let currentLine: { readonly relativePath: string; readonly line: number } | null = null

const BREAKPOINT_CLASS = 'bcc-breakpoint-glyph'
const BREAKPOINT_UNVERIFIED_CLASS = 'bcc-breakpoint-glyph bcc-breakpoint-glyph--unverified'
const CURRENT_LINE_CLASS = 'bcc-debug-current-line'
const CURRENT_LINE_GLYPH_CLASS = 'bcc-debug-current-glyph'

export function breakpointsFor(relativePath: string): readonly number[] {
  const lines = linesByPath.get(relativePath)
  return lines === undefined ? [] : [...lines].sort((a, b) => a - b)
}

function decorationsFor(relativePath: string): monacoNs.editor.IModelDeltaDecoration[] {
  const verified = verifiedByPath.get(relativePath)
  return breakpointsFor(relativePath).map((line) => ({
    range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
    options: {
      isWholeLine: false,
      glyphMarginClassName:
        verified?.get(line) === false ? BREAKPOINT_UNVERIFIED_CLASS : BREAKPOINT_CLASS,
      glyphMarginHoverMessage: {
        value: verified?.get(line) === false ? 'Unverified breakpoint' : 'Breakpoint'
      }
    }
  }))
}

/** Redraws one model's breakpoint dots from the current in-memory state. */
export function syncBreakpointDecorations(
  relativePath: string,
  model: monacoNs.editor.ITextModel
): void {
  const previous = decorationIdsByPath.get(relativePath) ?? []
  const next = model.deltaDecorations(previous, decorationsFor(relativePath))
  decorationIdsByPath.set(relativePath, next)
}

/** Reapplies whichever model the editor is currently showing — tab switches included. */
function syncActiveModel(editor: monacoNs.editor.IStandaloneCodeEditor): void {
  const model = editor.getModel()
  if (model === null) return
  const relativePath = relativePathFromUri(model.uri)
  if (relativePath === null) return
  syncBreakpointDecorations(relativePath, model)
  applyCurrentLineDecoration(editor)
}

/**
 * Toggles a breakpoint at `line` and tells `dap-service.ts`.
 *
 * The gutter updates twice: immediately, optimistically, and again once the
 * adapter's `verified` answer lands — a session that is not currently
 * running answers every line unverified, which is the honest state rather
 * than a guess.
 */
export async function toggleBreakpoint(
  relativePath: string,
  model: monacoNs.editor.ITextModel,
  line: number
): Promise<void> {
  const lines = linesByPath.get(relativePath) ?? new Set<number>()
  if (lines.has(line)) lines.delete(line)
  else lines.add(line)

  if (lines.size === 0) linesByPath.delete(relativePath)
  else linesByPath.set(relativePath, lines)

  syncBreakpointDecorations(relativePath, model)

  const result = await window.betterCallCompiler.dap.setBreakpoints({
    relativePath,
    lines: breakpointsFor(relativePath) as number[]
  })
  if (result.ok) {
    verifiedByPath.set(
      relativePath,
      new Map(result.value.breakpoints.map((breakpoint) => [breakpoint.line ?? line, breakpoint.verified]))
    )
  }
  if (!model.isDisposed()) syncBreakpointDecorations(relativePath, model)
}

/** Marks (or clears, when either argument is null) the line execution is stopped on. */
export function setCurrentExecutionLine(relativePath: string | null, line: number | null): void {
  currentLine = relativePath !== null && line !== null ? { relativePath, line } : null
  if (editorRef !== null) applyCurrentLineDecoration(editorRef)
}

function applyCurrentLineDecoration(editor: monacoNs.editor.IStandaloneCodeEditor): void {
  const model = editor.getModel()
  const belongsHere =
    model !== null && currentLine !== null && relativePathFromUri(model.uri) === currentLine.relativePath

  const decorations: monacoNs.editor.IModelDeltaDecoration[] =
    belongsHere && currentLine !== null
      ? [
          {
            range: {
              startLineNumber: currentLine.line,
              startColumn: 1,
              endLineNumber: currentLine.line,
              endColumn: 1
            },
            options: {
              isWholeLine: true,
              className: CURRENT_LINE_CLASS,
              glyphMarginClassName: CURRENT_LINE_GLYPH_CLASS
            }
          }
        ]
      : []

  currentLineDecorationIds = editor.deltaDecorations(currentLineDecorationIds, decorations)
}

/**
 * Wires the gutter: click the glyph margin or the line-number strip to toggle
 * a breakpoint, same as every other editor with one.
 */
export function registerBreakpointGutter(
  ns: typeof monacoNs,
  editor: monacoNs.editor.IStandaloneCodeEditor
): void {
  editorRef = editor

  editor.onMouseDown((event) => {
    const type = event.target.type
    if (
      type !== ns.editor.MouseTargetType.GUTTER_GLYPH_MARGIN &&
      type !== ns.editor.MouseTargetType.GUTTER_LINE_NUMBERS
    ) {
      return
    }

    const model = editor.getModel()
    const line = event.target.position?.lineNumber
    if (model === null || line === undefined) return

    const relativePath = relativePathFromUri(model.uri)
    if (relativePath === null) return

    void toggleBreakpoint(relativePath, model, line)
  })

  editor.onDidChangeModel(() => syncActiveModel(editor))
  syncActiveModel(editor)
}

/** For the Debug view's breakpoints list, which the user can also clear from there. */
export function clearBreakpoint(relativePath: string, line: number): Promise<void> {
  const ns = monacoRuntime()
  const model = ns === null ? null : ns.editor.getModel(documentUri(ns, relativePath))
  if (model === null) {
    // The file is not open; still tell dap-service, and no decoration to redraw.
    const lines = linesByPath.get(relativePath)
    if (lines !== undefined) {
      lines.delete(line)
      if (lines.size === 0) linesByPath.delete(relativePath)
    }
    return window.betterCallCompiler.dap
      .setBreakpoints({ relativePath, lines: breakpointsFor(relativePath) as number[] })
      .then(() => undefined)
  }
  return toggleBreakpoint(relativePath, model, line)
}

export function allBreakpoints(): ReadonlyMap<string, readonly number[]> {
  return new Map([...linesByPath.keys()].map((path) => [path, breakpointsFor(path)]))
}
