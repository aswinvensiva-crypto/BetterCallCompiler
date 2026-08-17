import type * as monacoNs from 'monaco-editor'
import { languageForFile } from './language-id'
import { monaco } from './monaco-setup'
import type { GitFileDiff } from '../../shared/types'

/**
 * Monaco's `DiffEditor`, used by the SCM view (step 8) and — in step 11 — to
 * preview every AI edit before it touches a file.
 *
 * Built once and re-modelled per diff, for the same reason the code editor is:
 * tearing a Monaco instance down and recreating it per file is measurably slow
 * and throws away scroll position. Its two models are disposed on each swap
 * though, unlike the editor's — a diff side is a snapshot of a revision, not a
 * document the user is editing, so there is no undo history worth keeping and
 * holding them would leak one model pair per file viewed.
 */

let diffEditor: monacoNs.editor.IStandaloneDiffEditor | null = null
let host: HTMLElement | null = null
let body: HTMLElement | null = null
let original: monacoNs.editor.ITextModel | null = null
let modified: monacoNs.editor.ITextModel | null = null
let titleEl: HTMLElement | null = null

let onCloseRequested: (() => void) | null = null

export function isDiffVisible(): boolean {
  return host !== null && !host.hidden
}

function disposeModels(): void {
  original?.dispose()
  modified?.dispose()
  original = null
  modified = null
}

export function mountDiffEditor(container: HTMLElement, onClose: () => void): void {
  onCloseRequested = onClose

  const wrap = document.createElement('div')
  wrap.className = 'diff-surface'
  wrap.id = 'diff-surface'
  wrap.hidden = true

  const header = document.createElement('div')
  header.className = 'diff-surface__header'

  titleEl = document.createElement('span')
  titleEl.className = 'diff-surface__title'
  header.append(titleEl)

  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'icon-button'
  close.title = 'Close diff'
  close.setAttribute('aria-label', 'Close diff')
  close.innerHTML =
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" ' +
    'stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>'
  close.addEventListener('click', () => hideDiff())
  header.append(close)

  const surface = document.createElement('div')
  surface.className = 'diff-surface__body'
  surface.id = 'diff-body'

  wrap.append(header, surface)
  container.append(wrap)
  host = wrap
  body = surface
}

/**
 * Builds the diff editor on first use.
 *
 * Not at mount, because a `DiffEditor` puts several `.monaco-editor` nodes into
 * the document — the two panes and the gutter between them — and the code
 * editor's own tests locate `.monaco-editor` expecting one. Deferring also means
 * a session that never opens a diff never pays for a second Monaco instance.
 */
function ensureDiffEditor(): monacoNs.editor.IStandaloneDiffEditor | null {
  if (diffEditor !== null) return diffEditor
  if (body === null) return null

  diffEditor = monaco.editor.createDiffEditor(body, {
    theme: 'bettercallcompiler-dark',
    automaticLayout: true,
    readOnly: true,
    // The whole point is comparing two revisions of the same file; an inline
    // view hides which side a line came from.
    renderSideBySide: true,
    originalEditable: false,
    fontFamily: 'Cascadia Code, Cascadia Mono, Consolas, monospace',
    fontSize: 13,
    lineHeight: 20,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    ignoreTrimWhitespace: false
  })
  return diffEditor
}

export function showDiff(diff: GitFileDiff): void {
  const editor = ensureDiffEditor()
  if (editor === null || host === null) return

  disposeModels()

  const language = languageForFile(diff.path)
  // Deliberately model-less URIs: `createModel` with an explicit URI would
  // collide with the editing model for the same file and Monaco throws.
  original = monaco.editor.createModel(diff.original, language)
  modified = monaco.editor.createModel(diff.modified, language)

  editor.setModel({ original, modified })

  if (titleEl !== null) {
    titleEl.textContent = `${diff.path} — ${diff.originalLabel} ↔ ${diff.modifiedLabel}`
    titleEl.title = titleEl.textContent
  }

  host.hidden = false
}

export function hideDiff(): void {
  if (host === null) return
  host.hidden = true
  // Dropping the models frees the text; the editor itself is reused.
  diffEditor?.setModel(null)
  disposeModels()
  onCloseRequested?.()
}
