import type * as monacoNs from 'monaco-editor'
import { languageForFile, monaco } from './monaco-setup'
import type { FileNode } from '../../shared/types'

/**
 * One `ITextModel` per file, keyed by URI and never disposed on tab switch.
 *
 * This is what makes undo history and cursor/scroll position survive switching
 * away from a file and back. Recreating a model on every activation — the
 * obvious shortcut — silently throws away the undo stack, which users
 * experience as the editor "forgetting" their work.
 */
export interface OpenDocument {
  readonly node: FileNode
  readonly model: monacoNs.editor.ITextModel
  /**
   * `getAlternativeVersionId()` at the last save. Comparing against the current
   * value is how dirty state is derived: it is stable across undo/redo, so
   * undoing back to the saved content correctly reports *not* dirty, which a
   * naive version counter gets wrong.
   */
  savedVersionId: number
  viewState: monacoNs.editor.ICodeEditorViewState | null
}

/**
 * Documents are keyed by a *normalised* path, not the raw string.
 *
 * The same file reaches this module spelled several ways: the explorer and the
 * watcher deliver what `node:path` produced (`C:\work\a.js`), while a location
 * parsed out of a stack trace is assembled by the run view and arrives
 * forward-slashed. Keying on the raw string opens two tabs for one file, and
 * because both resolve to the same Monaco URI they share a model — so closing
 * either one disposes the model the other is still showing.
 */
function keyFor(path: string): string {
  const unified = path.replace(/\\/g, '/')
  // Drive letters make the whole path case-insensitive on Windows.
  return /^[a-zA-Z]:\//.test(unified) ? unified.toLowerCase() : unified
}

const documents = new Map<string, OpenDocument>()
/** Tab order, holding the same normalised keys as `documents`. */
const order: string[] = []

let activePath: string | null = null
let editor: monacoNs.editor.IStandaloneCodeEditor | null = null

const changeListeners = new Set<() => void>()

export function onDocumentsChanged(listener: () => void): () => void {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}

function notify(): void {
  for (const listener of changeListeners) listener()
}

export function attachEditor(instance: monacoNs.editor.IStandaloneCodeEditor): void {
  editor = instance
}

export function openDocuments(): readonly OpenDocument[] {
  return order.map((path) => documents.get(path)).filter((doc): doc is OpenDocument => doc !== undefined)
}

export function activeDocument(): OpenDocument | null {
  return activePath === null ? null : (documents.get(activePath) ?? null)
}

export function isDirty(doc: OpenDocument): boolean {
  return doc.model.getAlternativeVersionId() !== doc.savedVersionId
}

export function anyDirty(): boolean {
  return openDocuments().some(isDirty)
}

/** Monaco keys models by URI; a stable per-file URI is what dedupes them. */
function uriFor(node: FileNode): monacoNs.Uri {
  return monaco.Uri.parse(`bettercallcompiler:///${encodeURI(node.relativePath)}`)
}

export async function openFile(node: FileNode): Promise<boolean> {
  const key = keyFor(node.path)
  const existing = documents.get(key)
  if (existing !== undefined) {
    activate(key)
    return true
  }

  const result = await window.betterCallCompiler.fs.readFile({ path: node.path })
  if (!result.ok) return false

  const uri = uriFor(node)
  const model =
    monaco.editor.getModel(uri) ??
    monaco.editor.createModel(result.value.content, languageForFile(node.name), uri)

  const doc: OpenDocument = {
    node,
    model,
    savedVersionId: model.getAlternativeVersionId(),
    viewState: null
  }

  model.onDidChangeContent(() => notify())

  documents.set(key, doc)
  order.push(key)
  activate(key)
  return true
}

/**
 * Opens a file and puts the cursor on a specific position.
 *
 * This is what a clickable `file:line:col` in the output console lands on.
 * `revealPositionInCenter` rather than `revealPosition`: a stack frame usually
 * needs its surrounding lines to be readable, and a location pinned to the
 * bottom edge of the viewport is not.
 */
export async function revealLocation(
  node: FileNode,
  line: number,
  column: number | null
): Promise<boolean> {
  const opened = await openFile(node)
  if (!opened || editor === null) return false

  const doc = documents.get(keyFor(node.path))
  if (doc === undefined) return false

  // Clamp: output can outlive the file it refers to, and Monaco throws on a
  // position past the end of the model.
  const lineCount = doc.model.getLineCount()
  const targetLine = Math.min(Math.max(1, line), lineCount)
  const maxColumn = doc.model.getLineMaxColumn(targetLine)
  const targetColumn = Math.min(Math.max(1, column ?? 1), maxColumn)

  const position = { lineNumber: targetLine, column: targetColumn }
  editor.setPosition(position)
  editor.revealPositionInCenter(position)
  editor.focus()
  return true
}

export function activate(path: string): void {
  const key = keyFor(path)
  const doc = documents.get(key)
  if (doc === undefined || editor === null) return

  // Re-activating the current document would re-render the tab bar for no
  // reason, tearing down DOM that may be mid-interaction.
  if (activePath === key) {
    editor.focus()
    return
  }

  // Preserve where the user was in the outgoing document before swapping.
  const outgoing = activeDocument()
  if (outgoing !== null && keyFor(outgoing.node.path) !== key) {
    outgoing.viewState = editor.saveViewState()
  }

  activePath = key
  editor.setModel(doc.model)
  if (doc.viewState !== null) editor.restoreViewState(doc.viewState)
  editor.focus()
  notify()
}

export async function save(doc: OpenDocument): Promise<boolean> {
  // Capture the id *before* awaiting: an edit landing mid-write must leave the
  // document dirty rather than be marked saved.
  const versionAtWrite = doc.model.getAlternativeVersionId()
  const result = await window.betterCallCompiler.fs.writeFile({
    path: doc.node.path,
    content: doc.model.getValue()
  })
  if (!result.ok) return false

  doc.savedVersionId = versionAtWrite
  notify()
  return true
}

export async function saveActive(): Promise<boolean> {
  const doc = activeDocument()
  if (doc === null || !isDirty(doc)) return true
  return await save(doc)
}

export function close(path: string): void {
  const key = keyFor(path)
  const doc = documents.get(key)
  if (doc === undefined) return

  documents.delete(key)
  const index = order.indexOf(key)
  if (index >= 0) order.splice(index, 1)

  doc.model.dispose()

  if (activePath === key) {
    activePath = null
    const next = order[Math.min(index, order.length - 1)]
    if (next !== undefined) {
      activate(next)
    } else if (editor !== null) {
      editor.setModel(null)
    }
  }

  notify()
}

/** External change (git checkout, another editor) for a file we have open. */
export async function reloadFromDisk(path: string): Promise<void> {
  const doc = documents.get(keyFor(path))
  if (doc === undefined) return
  // Never clobber unsaved work; the user's buffer wins until they decide.
  if (isDirty(doc)) return

  const result = await window.betterCallCompiler.fs.readFile({ path })
  if (!result.ok) return
  if (result.value.content === doc.model.getValue()) return

  doc.model.setValue(result.value.content)
  doc.savedVersionId = doc.model.getAlternativeVersionId()
  notify()
}

export function closeAll(): void {
  for (const path of [...order]) close(path)
}
