import type * as monacoNs from 'monaco-editor'
import { isBccPath } from '../../shared/lang-diagnostics'
import type {
  CodeLine,
  FileNode,
  ObservatoryFunction,
  ObservatorySnapshot,
  SourceRange
} from '../../shared/types'
import { showTextDiff } from '../editor/diff'
import { activeDocument, onDocumentsChanged, revealLocation } from '../editor/models'
import { activeRightDockView, isRightDockVisible } from '../workbench/right-dock'

/**
 * Part 11: the Observatory.
 *
 * Every stage BCC's own compiler goes through, for whichever `.bcc` file is
 * open: source, tokens, the AST, the scope tree, then per function IR, SSA,
 * the four Part 8 passes and the compiled bytecode. One round trip —
 * `compiler:observatory` — answers all of it, because the daemon already
 * builds every one of those stages to answer `compiler:diagnostics`; this
 * view is a second window onto work it was already doing, the same
 * justification the Compiler Intelligence panel has for existing at all.
 *
 * Tracks the ACTIVE editor the same way the Visualizer does, but through its
 * own listener rather than a feed wired in `main.ts`: this view is BCC-only
 * and lazily mounted, so wiring it into the always-on editor feed would cost
 * every TypeScript-only session a subscription it can never use.
 */

const api = window.betterCallCompiler

type TabId = 'source' | 'tokens' | 'ast' | 'symbols' | 'ir' | 'ssa' | 'passes' | 'bytecode'

const TABS: readonly { readonly id: TabId; readonly label: string }[] = [
  { id: 'source', label: 'Source' },
  { id: 'tokens', label: 'Tokens' },
  { id: 'ast', label: 'AST' },
  { id: 'symbols', label: 'Symbols' },
  { id: 'ir', label: 'IR' },
  { id: 'ssa', label: 'SSA' },
  { id: 'passes', label: 'Passes' },
  { id: 'bytecode', label: 'Bytecode' }
]

/** These four are answered per function; the rest describe the whole file. */
const PER_FUNCTION_TABS: ReadonlySet<TabId> = new Set(['ir', 'ssa', 'passes', 'bytecode'])

const REFRESH_DEBOUNCE_MS = 300

let bodyHost: HTMLElement | null = null
let activeTab: TabId = 'source'

/** The file this view is currently tracking, or null when the active editor
 * is not a `.bcc` file (or there is no active editor at all). */
let currentRelativePath: string | null = null
let snapshot: ObservatorySnapshot | null = null
let selectedFunction: string | null = null

let contentDisposable: monacoNs.IDisposable | null = null
let refreshTimer: ReturnType<typeof setTimeout> | null = null
let unsubscribeDocs: (() => void) | null = null

/** True only while this is the visible right-dock view — see `isRightDockVisible`. */
function isShowing(): boolean {
  return isRightDockVisible() && activeRightDockView() === 'observatory'
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/* -------------------------------- fetching -------------------------------- */

async function fetchSnapshot(relativePath: string): Promise<void> {
  const doc = activeDocument()
  const overlay =
    doc !== null && doc.node.relativePath === relativePath
      ? { content: doc.model.getValue(), version: doc.model.getVersionId() }
      : null

  const result = await api.compiler.observatory({ relativePath, overlay })
  // The active file can change while this round trip is in flight; a stale
  // answer must not overwrite whatever the user has since switched to.
  if (!result.ok || currentRelativePath !== relativePath) return

  snapshot = result.value
  if (selectedFunction === null || !snapshot.functions.some((fn) => fn.name === selectedFunction)) {
    selectedFunction =
      snapshot.functions.find((fn) => !fn.isSynthetic)?.name ?? snapshot.functions[0]?.name ?? null
  }
  if (isShowing()) render()
}

function scheduleRefresh(): void {
  if (refreshTimer !== null) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    // Hidden: the fetch is skipped outright, not just the re-render — this is
    // a full lower/SSA/optimise/compile round trip per function, not a cheap
    // read, and `onObservatoryShown` refreshes unconditionally on the way
    // back in.
    if (!isShowing()) return
    if (currentRelativePath !== null) void fetchSnapshot(currentRelativePath)
  }, REFRESH_DEBOUNCE_MS)
}

function detachContentListener(): void {
  contentDisposable?.dispose()
  contentDisposable = null
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }
}

function attachContentListener(model: monacoNs.editor.ITextModel): void {
  contentDisposable = model.onDidChangeContent(() => scheduleRefresh())
}

/**
 * Re-reads which file the editor is showing, and starts tracking it if it
 * changed. Cheap to call on every `onDocumentsChanged` firing — which
 * includes every keystroke in every OPEN document, not just the active one —
 * because the early return below is the only work done for all of them.
 */
function syncActiveFile(): void {
  const doc = activeDocument()
  const relativePath = doc !== null && isBccPath(doc.node.relativePath) ? doc.node.relativePath : null

  if (relativePath === currentRelativePath) return

  detachContentListener()
  currentRelativePath = relativePath
  snapshot = null
  selectedFunction = null

  if (relativePath === null) {
    if (isShowing()) render()
    return
  }

  if (doc !== null) attachContentListener(doc.model)
  if (isShowing()) {
    render() // shows the empty state immediately while the fetch is in flight
    void fetchSnapshot(relativePath)
  }
}

/* -------------------------------- rendering ------------------------------- */

function revealRange(range: SourceRange): void {
  if (snapshot === null) return
  const node: FileNode = {
    name: snapshot.relativePath.slice(snapshot.relativePath.lastIndexOf('/') + 1),
    path: snapshot.path,
    relativePath: snapshot.relativePath,
    kind: 'file'
  }
  void revealLocation(node, range.startLine, range.startColumn)
}

/**
 * The one component every stage but Source and Passes renders through:
 * `CodeLine`s carry their own indentation as leading spaces in `text`, and a
 * line whose `range` is non-null reveals it in the editor on click — the
 * whole payoff of every stage since Part 1 threading a span through.
 */
function renderLines(lines: readonly CodeLine[]): HTMLElement {
  const list = el('div', 'obs-lines')
  for (const codeLine of lines) {
    const row = el('div', 'obs-line', codeLine.text)
    if (codeLine.range !== null) {
      const range = codeLine.range
      row.classList.add('obs-line--clickable')
      row.title = `Line ${range.startLine}`
      row.addEventListener('click', () => revealRange(range))
    }
    list.append(row)
  }
  if (lines.length === 0) list.append(el('p', 'explorer__empty-text', 'Nothing to show.'))
  return list
}

function renderSource(): HTMLElement {
  const pre = el('pre', 'obs-source')
  pre.textContent = snapshot?.source ?? ''
  return pre
}

function currentFunction(): ObservatoryFunction | null {
  if (snapshot === null) return null
  return snapshot.functions.find((fn) => fn.name === selectedFunction) ?? null
}

function renderFunctionPicker(): HTMLElement {
  const strip = el('div', 'obs-functions')
  for (const fn of snapshot?.functions ?? []) {
    const button = el('button', 'obs-functions__item', fn.isSynthetic ? '<main>' : fn.name)
    button.type = 'button'
    button.setAttribute('aria-selected', String(fn.name === selectedFunction))
    button.addEventListener('click', () => {
      selectedFunction = fn.name
      render()
    })
    strip.append(button)
  }
  return strip
}

function renderFailure(failure: { readonly pass: string | null; readonly message: string }): HTMLElement {
  const wrap = el('div', 'obs-failure')
  wrap.append(
    el(
      'p',
      'ci-note',
      failure.pass === null
        ? `The IR was already malformed before any pass ran: ${failure.message}`
        : `${failure.pass} produced invalid IR: ${failure.message}`
    )
  )
  return wrap
}

function linesToText(lines: readonly CodeLine[]): string {
  return lines.map((line) => line.text).join('\n')
}

/** One row per Part 8 pass this function went through, with a diff on demand. */
function renderPasses(fn: ObservatoryFunction): HTMLElement {
  const wrap = el('div', 'obs-passes')

  if (fn.failure !== null) wrap.append(renderFailure(fn.failure))

  if (fn.passes.length === 0) {
    wrap.append(el('p', 'explorer__empty-text', 'No passes ran.'))
    return wrap
  }

  for (const pass of fn.passes) {
    const row = el('div', 'obs-pass')

    const header = el('div', 'obs-pass__header')
    header.append(el('span', 'obs-pass__name', pass.name))
    header.append(
      el(
        'span',
        `ci-tag ${pass.changed ? 'ci-tag--recomputed' : 'ci-tag--validated'}`,
        pass.changed ? 'changed' : 'no change'
      )
    )
    row.append(header)

    row.append(el('p', 'obs-pass__summary', pass.summary))

    if (pass.notes.length > 0) {
      const notes = el('ul', 'obs-pass__notes')
      for (const note of pass.notes) notes.append(el('li', undefined, note))
      row.append(notes)
    }

    const diffButton = el('button', 'button obs-pass__diff', 'View diff')
    diffButton.type = 'button'
    diffButton.disabled = !pass.changed
    diffButton.addEventListener('click', () => {
      const label = fn.isSynthetic ? '<main>' : fn.name
      void showTextDiff(`${label} — ${pass.name}`, linesToText(pass.before), linesToText(pass.after))
    })
    row.append(diffButton)

    wrap.append(row)
  }

  return wrap
}

function renderActiveTab(): HTMLElement {
  switch (activeTab) {
    case 'source':
      return renderSource()
    case 'tokens':
      return renderLines(snapshot?.tokens ?? [])
    case 'ast':
      return renderLines(snapshot?.ast ?? [])
    case 'symbols':
      return renderLines(snapshot?.symbols ?? [])
    case 'ir': {
      const fn = currentFunction()
      return fn === null ? el('p', 'explorer__empty-text', 'No function selected.') : renderLines(fn.ir)
    }
    case 'ssa': {
      const fn = currentFunction()
      return fn === null ? el('p', 'explorer__empty-text', 'No function selected.') : renderLines(fn.ssa)
    }
    case 'bytecode': {
      const fn = currentFunction()
      if (fn === null) return el('p', 'explorer__empty-text', 'No function selected.')
      if (fn.bytecode === null) {
        return renderFailure(fn.failure ?? { pass: null, message: 'nothing verified to compile' })
      }
      return renderLines(fn.bytecode)
    }
    case 'passes': {
      const fn = currentFunction()
      return fn === null ? el('p', 'explorer__empty-text', 'No function selected.') : renderPasses(fn)
    }
  }
}

function render(): void {
  if (bodyHost === null) return

  const root = el('div', 'obs')

  const strip = el('div', 'obs-tabs')
  for (const tab of TABS) {
    const button = el('button', 'obs-tabs__tab', tab.label)
    button.type = 'button'
    button.dataset['tabId'] = tab.id
    button.setAttribute('aria-selected', String(tab.id === activeTab))
    button.addEventListener('click', () => {
      activeTab = tab.id
      render()
    })
    strip.append(button)
  }
  root.append(strip)

  if (currentRelativePath === null) {
    root.append(
      el(
        'p',
        'explorer__empty-text',
        'The Observatory shows BCC compiler internals — open a .bcc file to inspect it.'
      )
    )
    bodyHost.replaceChildren(root)
    return
  }

  if (snapshot === null) {
    root.append(el('p', 'explorer__empty-text', 'Loading…'))
    bodyHost.replaceChildren(root)
    return
  }

  const body = el('div', 'obs-body')
  if (PER_FUNCTION_TABS.has(activeTab)) body.append(renderFunctionPicker())
  body.append(renderActiveTab())
  root.append(body)

  bodyHost.replaceChildren(root)
}

/* --------------------------------- mounting ------------------------------- */

export function mountObservatory(title: HTMLElement, body: HTMLElement): void {
  bodyHost = body
  title.replaceChildren(el('span', 'right-dock__title-text', 'Observatory'))

  unsubscribeDocs?.()
  unsubscribeDocs = onDocumentsChanged(() => syncActiveFile())

  syncActiveFile()
  render()
}

/**
 * Refreshes unconditionally on every activation — the debounced refresh in
 * `scheduleRefresh` deliberately skips its fetch while this view is hidden,
 * so an edit made while looking at another tab must be picked up here rather
 * than left showing whatever was last fetched.
 */
export function onObservatoryShown(): void {
  syncActiveFile()
  if (currentRelativePath !== null) void fetchSnapshot(currentRelativePath)
  render()
}
