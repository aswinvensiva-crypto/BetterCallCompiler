import { openFile, revealLocation } from '../editor/models'
import { notifyError } from '../workbench/notifications'
import type {
  CompilerStatus,
  DiagnosticMessage,
  DiagnosticSeverity,
  FileDiagnostics,
  FileNode
} from '../../shared/types'

/**
 * The Problems panel.
 *
 * A list of what the compiler daemon actually found, which until now existed
 * only as squiggles in files the user happened to have open. Rows navigate via
 * `revealLocation` — the same function the run console's error links use, so a
 * diagnostic and a stack-trace link land in exactly the same place.
 */

/**
 * Asks the Compiler Intelligence panel to explain one file's recheck.
 *
 * Declared here, with the dispatcher, the same way EXPLAIN_ARTIFACT_EVENT and
 * ASSIST_ACTION_EVENT are — the consumer imports it, which keeps the dependency
 * one-directional and cycle-free.
 */
export const WHY_FILE_EVENT = 'bettercallcompiler:why-file'

export interface WhyFileDetail {
  readonly relativePath: string
}

let bodyHost: HTMLElement | null = null
let actionsHost: HTMLElement | null = null

let files: FileDiagnostics[] = []
let status: CompilerStatus | null = null
let workspaceRoot: string | null = null

/** Collapsed files, keyed by relative path. Survives re-renders. */
const collapsed = new Set<string>()

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

const SEVERITY_RANK: Readonly<Record<DiagnosticSeverity, number>> = {
  error: 0,
  warning: 1,
  info: 2,
  hint: 3
}

/** Files with diagnostics, errors first, then by path. */
function visibleFiles(): FileDiagnostics[] {
  return files
    .filter((file) => file.diagnostics.length > 0)
    .sort((a, b) => {
      const aWorst = Math.min(...a.diagnostics.map((d) => SEVERITY_RANK[d.severity]))
      const bWorst = Math.min(...b.diagnostics.map((d) => SEVERITY_RANK[d.severity]))
      if (aWorst !== bWorst) return aWorst - bWorst
      return a.relativePath.localeCompare(b.relativePath)
    })
}

function counts(): { errors: number; warnings: number } {
  let errors = 0
  let warnings = 0
  for (const file of files) {
    for (const diagnostic of file.diagnostics) {
      if (diagnostic.severity === 'error') errors++
      else if (diagnostic.severity === 'warning') warnings++
    }
  }
  return { errors, warnings }
}

async function navigate(file: FileDiagnostics, diagnostic: DiagnosticMessage): Promise<void> {
  const node: FileNode = {
    name: file.relativePath.slice(file.relativePath.lastIndexOf('/') + 1),
    path: file.path,
    relativePath: file.relativePath,
    kind: 'file'
  }

  const opened = await openFile(node)
  if (!opened) {
    notifyError(`Could not open ${file.relativePath}`)
    return
  }
  await revealLocation(node, diagnostic.startLine, diagnostic.startColumn)
}

function renderDiagnosticRow(
  file: FileDiagnostics,
  diagnostic: DiagnosticMessage
): HTMLElement {
  const row = el('div', `problems-row problems-row--${diagnostic.severity}`)
  row.setAttribute('role', 'button')
  row.tabIndex = 0
  row.title = `${diagnostic.code}: ${diagnostic.message}`

  row.append(el('span', `problems-row__icon problems-row__icon--${diagnostic.severity}`))
  row.append(el('span', 'problems-row__message', diagnostic.message))
  row.append(el('span', 'problems-row__code', diagnostic.code))
  row.append(
    el('span', 'problems-row__position', `${diagnostic.startLine}:${diagnostic.startColumn}`)
  )

  // "Why was this rechecked?" — the Compiler Intelligence answer for this file.
  //
  // stopPropagation is load-bearing: the row itself navigates on click, so without
  // it pressing Why would also jump the editor and move the viewport out from
  // under the user while the dock opens.
  const why = el('button', 'icon-button problems-row__why')
  why.type = 'button'
  why.textContent = '?'
  why.title = 'Why was this file rechecked?'
  why.setAttribute('aria-label', `Why was ${file.relativePath} rechecked?`)
  why.addEventListener('click', (event) => {
    event.stopPropagation()
    document.dispatchEvent(
      new CustomEvent<WhyFileDetail>(WHY_FILE_EVENT, {
        detail: { relativePath: file.relativePath }
      })
    )
  })
  row.append(why)

  const go = (): void => void navigate(file, diagnostic)
  row.addEventListener('click', go)
  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      go()
    }
  })

  return row
}

function renderFileGroup(file: FileDiagnostics): HTMLElement {
  const group = el('div', 'problems-group')
  const isCollapsed = collapsed.has(file.relativePath)

  const header = el('div', 'problems-group__header')
  header.setAttribute('role', 'button')
  header.tabIndex = 0
  header.title = file.relativePath

  const chevron = el('span', `problems-group__chevron${isCollapsed ? '' : ' problems-group__chevron--open'}`)
  chevron.textContent = '›'
  header.append(chevron)
  header.append(el('span', 'problems-group__path', file.relativePath))
  header.append(el('span', 'problems-group__count', String(file.diagnostics.length)))

  const toggle = (): void => {
    if (collapsed.has(file.relativePath)) collapsed.delete(file.relativePath)
    else collapsed.add(file.relativePath)
    render()
  }
  header.addEventListener('click', toggle)
  header.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      toggle()
    }
  })

  group.append(header)

  if (!isCollapsed) {
    const sorted = [...file.diagnostics].sort(
      (a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        a.startLine - b.startLine ||
        a.startColumn - b.startColumn
    )
    for (const diagnostic of sorted) group.append(renderDiagnosticRow(file, diagnostic))
  }

  return group
}

/**
 * The daemon state chip.
 *
 * `failed` reads differently from `stopped` on purpose — a crashed daemon and a
 * deliberately idle one are not the same thing, and a panel that shows "0
 * problems" while the daemon is dead is lying by omission.
 */
function renderStatusChip(): HTMLElement {
  const state = status?.state ?? 'stopped'
  const chip = el('span', `problems-chip problems-chip--${state}`, state)

  if (status !== null) {
    const parts = [`${status.checkedFileCount} of ${status.graph.fileCount} files checked`]
    if (status.graph.tsconfigRelativePath !== null) {
      parts.push(`config: ${status.graph.tsconfigRelativePath}`)
    } else {
      parts.push('no tsconfig found — using fallback options')
    }
    if (status.graph.truncated) parts.push('workspace exceeded the scan limit')
    if (status.restarts > 0) parts.push(`${status.restarts} restart(s)`)
    if (status.detail !== null) parts.push(status.detail)
    chip.title = parts.join(' · ')
  }

  return chip
}

function render(): void {
  if (bodyHost === null) return

  bodyHost.replaceChildren()
  renderActions()

  if (workspaceRoot === null) {
    bodyHost.append(el('p', 'explorer__empty-text', 'Open a folder to see problems.'))
    return
  }

  const state = status?.state ?? 'stopped'
  if (state === 'failed') {
    const failure = el('div', 'problems-failure')
    failure.append(el('p', 'problems-failure__title', 'The compiler daemon stopped.'))
    failure.append(
      el('p', 'problems-failure__detail', status?.detail ?? 'No further detail was reported.')
    )
    bodyHost.append(failure)
    return
  }

  const groups = visibleFiles()
  if (groups.length === 0) {
    const message =
      state === 'indexing'
        ? 'Indexing the workspace…'
        : state === 'checking'
          ? 'Checking…'
          : 'No problems found.'
    bodyHost.append(el('p', 'explorer__empty-text', message))
    return
  }

  for (const file of groups) bodyHost.append(renderFileGroup(file))
}

function renderActions(): void {
  if (actionsHost === null) return
  actionsHost.replaceChildren()

  const { errors, warnings } = counts()
  const summary = el('span', 'problems-summary')
  summary.append(el('span', 'problems-summary__errors', `${errors} error${errors === 1 ? '' : 's'}`))
  summary.append(
    el('span', 'problems-summary__warnings', `${warnings} warning${warnings === 1 ? '' : 's'}`)
  )
  actionsHost.append(summary)
  actionsHost.append(renderStatusChip())

  const restart = el('button', 'icon-button')
  restart.type = 'button'
  restart.title = 'Restart the compiler daemon'
  restart.setAttribute('aria-label', 'Restart the compiler daemon')
  restart.innerHTML =
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.5M13 2v3h-3" ' +
    'fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  restart.addEventListener('click', () => {
    void window.betterCallCompiler.compiler.restart({})
  })
  actionsHost.append(restart)
}

/** Merges a batch into the local list; an empty set removes the file's group. */
function mergeBatch(incoming: readonly FileDiagnostics[]): void {
  const byPath = new Map(files.map((file) => [file.relativePath, file]))

  for (const file of incoming) {
    const existing = byPath.get(file.relativePath)
    if (existing !== undefined && existing.version > file.version) continue
    byPath.set(file.relativePath, file)
  }

  files = [...byPath.values()]
}

export function mountProblems(body: HTMLElement, actions: HTMLElement): void {
  bodyHost = body
  actionsHost = actions

  window.betterCallCompiler.compiler.onDiagnosticsChanged((batch) => {
    mergeBatch(batch.files)
    render()
  })

  window.betterCallCompiler.compiler.onStatusChanged((next) => {
    status = next
    // A restart invalidates everything the previous worker reported.
    if (next.state === 'restarting') files = []
    render()
  })

  void refresh()
}

/** Pulls a full snapshot — the panel must be accurate the moment it is shown. */
export async function refresh(): Promise<void> {
  const [workspace, snapshot, current] = await Promise.all([
    window.betterCallCompiler.fs.getWorkspace({}),
    window.betterCallCompiler.compiler.diagnostics({ relativePath: null }),
    window.betterCallCompiler.compiler.status({})
  ])

  workspaceRoot = workspace.ok ? workspace.value.root : null
  if (snapshot.ok) files = snapshot.value.files
  if (current.ok) status = current.value.status
  render()
}

export function onProblemsShown(): void {
  void refresh()
}
