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

const documents = new Map<string, OpenDocument>()
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
  return monaco.Uri.parse(`aperture:///${encodeURI(node.relativePath)}`)
}

export async function openFile(node: FileNode): Promise<void> {
  const existing = documents.get(node.path)
  if (existing !== undefined) {
    activate(node.path)
    return
  }

  const result = await window.aperture.fs.readFile({ path: node.path })
  if (!result.ok) return

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

  documents.set(node.path, doc)
  order.push(node.path)
  activate(node.path)
}

export function activate(path: string): void {
  const doc = documents.get(path)
  if (doc === undefined || editor === null) return

  // Re-activating the current document would re-render the tab bar for no
  // reason, tearing down DOM that may be mid-interaction.
  if (activePath === path) {
    editor.focus()
    return
  }

  // Preserve where the user was in the outgoing document before swapping.
  const outgoing = activeDocument()
  if (outgoing !== null && outgoing.node.path !== path) {
    outgoing.viewState = editor.saveViewState()
  }

  activePath = path
  editor.setModel(doc.model)
  if (doc.viewState !== null) editor.restoreViewState(doc.viewState)
  editor.focus()
  notify()
}

export async function save(doc: OpenDocument): Promise<boolean> {
  // Capture the id *before* awaiting: an edit landing mid-write must leave the
  // document dirty rather than be marked saved.
  const versionAtWrite = doc.model.getAlternativeVersionId()
  const result = await window.aperture.fs.writeFile({
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
  const doc = documents.get(path)
  if (doc === undefined) return

  documents.delete(path)
  const index = order.indexOf(path)
  if (index >= 0) order.splice(index, 1)

  doc.model.dispose()

  if (activePath === path) {
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
  const doc = documents.get(path)
  if (doc === undefined) return
  // Never clobber unsaved work; the user's buffer wins until they decide.
  if (isDirty(doc)) return

  const result = await window.aperture.fs.readFile({ path })
  if (!result.ok) return
  if (result.value.content === doc.model.getValue()) return

  doc.model.setValue(result.value.content)
  doc.savedVersionId = doc.model.getAlternativeVersionId()
  notify()
}

export function closeAll(): void {
  for (const path of [...order]) close(path)
}
