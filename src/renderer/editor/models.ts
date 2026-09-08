import type * as monacoNs from 'monaco-editor'
import { absolutePathFor, documentUri, relativePathFromUri, rememberAbsolutePath } from './document-uri'
import { languageForFile } from './language-id'
import { loadMonaco, monacoRuntime } from './monaco-setup'
import { flushPendingMarkers } from './markers'
import { closeDocument as closeSyntaxDocument } from './syntax-tree'
import { isServedByLsp } from '../../shared/lsp-registry'
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
  registerEditorOpener()
}

/**
 * Teaches Monaco how to open a file this app owns.
 *
 * Without this, go-to-definition across files silently does nothing. Monaco's
 * standalone model service resolves a URI only to a model that already exists,
 * so a definition in a file the user has never opened resolves to nothing and
 * F12 appears broken — which is precisely the case the daemon exists to answer
 * and the one Monaco's own worker cannot.
 *
 * Registered here rather than in `navigation-providers.ts` because opening a
 * file is this module's job: it owns the model map, the tab order and the
 * lifecycle. The provider module stays free of that, which is what keeps it
 * free of an import cycle back through `monaco-setup`.
 */
let openerRegistered = false

function registerEditorOpener(): void {
  if (openerRegistered) return
  const ns = monacoRuntime()
  // `attachEditor` is called with an editor that `createEditor` already awaited
  // `loadMonaco` for, so this is never null in practice — and returning without
  // setting the flag means a later call still gets its chance.
  if (ns === null) return
  openerRegistered = true

  ns.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selectionOrPosition) {
      const relativePath = relativePathFromUri(resource)
      if (relativePath === null) return false

      const path = absolutePathFor(relativePath)
      if (path === null) return false

      const name = relativePath.slice(relativePath.lastIndexOf('/') + 1)
      const node: FileNode = { name, path, relativePath, kind: 'file' }

      // `lineNumber` is present on an IPosition and on an IRange's start under
      // a different name, so the two are told apart by which field exists
      // rather than by trusting the caller to send one shape.
      const line =
        selectionOrPosition === undefined
          ? 1
          : 'lineNumber' in selectionOrPosition
            ? selectionOrPosition.lineNumber
            : selectionOrPosition.startLineNumber
      const column =
        selectionOrPosition === undefined
          ? 1
          : 'column' in selectionOrPosition
            ? selectionOrPosition.column
            : selectionOrPosition.startColumn

      // Returning true before the open resolves is what the interface asks for:
      // it means "handled", not "finished". Reporting false after an await
      // would let Monaco fall through to its own do-nothing default having
      // already opened the file.
      void revealLocation(node, line, column)
      return true
    }
  })
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

/**
 * Monaco keys models by URI; a stable per-file URI is what dedupes them.
 *
 * Built by `document-uri.ts` rather than inline, because the navigation
 * providers have to run the same construction BACKWARDS to tell the daemon
 * which file a model is. One encoder and one decoder, or the first path with a
 * space in it makes go-to-definition ask about a file that does not exist.
 */
function uriFor(ns: typeof monacoNs, node: FileNode): monacoNs.Uri {
  return documentUri(ns, node.relativePath)
}

/**
 * Sends the unsaved buffer to the daemon, debounced.
 *
 * 300ms because every push triggers a re-check of this file and everything
 * that imports it. Pushing per keystroke would queue a full type-check per
 * character; waiting for save would mean the squiggles describe a file the user
 * stopped looking at several edits ago.
 *
 * The version is Monaco's own version id, which increases monotonically per
 * model, so the daemon can discard an overlay that arrives out of order.
 */
const overlayTimers = new Map<string, ReturnType<typeof setTimeout>>()

const OVERLAY_DEBOUNCE_MS = 300

/**
 * Files an external language server has been told about, so the first push
 * for a file sends `textDocument/didOpen` and every push after it sends
 * `textDocument/didChange` — the two are not interchangeable, and sending
 * `didOpen` twice for one file is a protocol violation some servers reject
 * outright rather than merely ignore.
 */
const lspOpened = new Set<string>()

function pushLspOverlay(relativePath: string, model: monacoNs.editor.ITextModel): void {
  const languageId = model.getLanguageId()
  if (!isServedByLsp(languageId)) return

  const content = model.getValue()
  const version = model.getVersionId()

  if (lspOpened.has(relativePath)) {
    void window.betterCallCompiler.lsp.changeDocument({ relativePath, content, version })
  } else {
    lspOpened.add(relativePath)
    void window.betterCallCompiler.lsp.openDocument({ relativePath, languageId, content, version })
  }
}

function pushOverlay(relativePath: string, model: monacoNs.editor.ITextModel): void {
  const existing = overlayTimers.get(relativePath)
  if (existing !== undefined) clearTimeout(existing)

  overlayTimers.set(
    relativePath,
    setTimeout(() => {
      overlayTimers.delete(relativePath)
      if (model.isDisposed()) return
      void window.betterCallCompiler.compiler.openDocument({
        relativePath,
        content: model.getValue(),
        version: model.getVersionId()
      })
      pushLspOverlay(relativePath, model)
    }, OVERLAY_DEBOUNCE_MS)
  )
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

  // So the editor opener can find this file again by relative path alone.
  rememberAbsolutePath(node.relativePath, node.path)

  // Awaited here rather than relying on boot order, which makes opening a file
  // self-sufficient: a click in the explorer during the Monaco load resolves once
  // it arrives instead of being dropped.
  const ns = await loadMonaco()

  const uri = uriFor(ns, node)
  const model =
    ns.editor.getModel(uri) ??
    ns.editor.createModel(result.value.content, languageForFile(node.name), uri)

  const doc: OpenDocument = {
    node,
    model,
    savedVersionId: model.getAlternativeVersionId(),
    viewState: null
  }

  model.onDidChangeContent(() => {
    notify()
    pushOverlay(node.relativePath, model)
  })

  // The daemon reports on the whole invalidation set, most of which is not
  // open. Anything parked for this file is drained now, so opening it shows
  // its squiggles immediately instead of waiting for the next unrelated edit.
  flushPendingMarkers(node.relativePath)

  // Seed the overlay on open, so a file that is already dirty from a previous
  // session — or simply differs from disk — is checked as the user sees it.
  pushOverlay(node.relativePath, model)

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

  // The buffer is gone, so the daemon must go back to reading this file from
  // disk rather than serving an overlay nobody is updating any more.
  void window.betterCallCompiler.compiler.closeDocument({
    relativePath: doc.node.relativePath
  })

  if (lspOpened.delete(doc.node.relativePath)) {
    void window.betterCallCompiler.lsp.closeDocument({ relativePath: doc.node.relativePath })
  }

  // Before dispose, and keyed on the URI rather than on `keyFor(path)`: the
  // syntax layer indexes documents by `model.uri.toString()`, which is what
  // registerSyntaxFeed passes when it adopts a model.
  //
  // Without this every file ever opened kept a tree-sitter Parser and Tree alive
  // for the whole session — `closeAllDocuments()` existed in that module and had
  // no caller anywhere, which was the tell that the lifecycle was never wired.
  closeSyntaxDocument(doc.model.uri.toString())

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
