import { activeDocument, revealLocation } from '../editor/models'
import { languageForFile } from '../editor/language-id'
import { absolutePathFor } from '../editor/document-uri'
import { allBreakpoints, clearBreakpoint, setCurrentExecutionLine } from '../editor/breakpoints'
import { notify, notifyError } from '../workbench/notifications'
import type {
  DapOutputRecord,
  DapScopeRecord,
  DapSessionStatusRecord,
  DapStackFrameRecord,
  DapThreadRecord,
  DapVariableRecord,
  FileNode
} from '../../shared/types'

/**
 * The Debug side-bar view: controls, call stack, variables and breakpoints
 * for the one active DAP session `dap-service.ts` allows.
 *
 * State lives at module scope, exactly like `problems.ts`, and its listeners
 * are wired once at boot via `initDebugListeners` — *not* on first mount —
 * because a session started from F5 must keep tracking state whether or not
 * the user has ever opened this view. `render()` is a no-op until
 * `mountDebug` supplies a body host, so nothing is lost either way; it simply
 * catches up the first time the view is shown.
 */

let bodyHost: HTMLElement | null = null
let listenersWired = false

let status: DapSessionStatusRecord | null = null
let threads: readonly DapThreadRecord[] = []
let frames: readonly DapStackFrameRecord[] = []
let selectedFrameId: number | null = null
let scopes: readonly DapScopeRecord[] = []
let output: DapOutputRecord[] = []
let workspaceRoot: string | null = null

/** Keyed by `variablesReference` — scopes are folded into the same tree. */
const variableCache = new Map<number, DapVariableRecord[]>()
const expandedRefs = new Set<number>()

const MAX_OUTPUT_LINES = 2_000

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

function basenameOf(path: string): string {
  const clean = path.replace(/\\/g, '/')
  return clean.slice(clean.lastIndexOf('/') + 1)
}

/* -------------------------------------------------------------------------- */
/*  Workspace-relative paths                                                  */
/* -------------------------------------------------------------------------- */

async function ensureWorkspaceRoot(): Promise<string | null> {
  if (workspaceRoot !== null) return workspaceRoot
  const result = await window.betterCallCompiler.fs.getWorkspace({})
  if (result.ok) workspaceRoot = result.value.root
  return workspaceRoot
}

/**
 * A stack frame's path is absolute — the adapter has no idea this app has a
 * workspace — so it is turned back into the relative form every model here is
 * keyed by. A simple prefix strip rather than real path resolution, because
 * both sides already agree on separators; case-insensitive so a Windows drive
 * letter's casing cannot make an in-workspace frame look external.
 */
function toWorkspaceRelative(absolutePath: string, root: string): string | null {
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/, '')
  const normalizedPath = absolutePath.replace(/\\/g, '/')
  const prefix = `${normalizedRoot}/`
  if (normalizedPath.toLowerCase().startsWith(prefix.toLowerCase())) {
    return normalizedPath.slice(prefix.length)
  }
  return null
}

async function revealFrame(frame: DapStackFrameRecord): Promise<void> {
  if (frame.path === null) return
  const root = await ensureWorkspaceRoot()
  if (root === null) return
  const relativePath = toWorkspaceRelative(frame.path, root)
  if (relativePath === null) return

  const node: FileNode = {
    name: basenameOf(relativePath),
    path: frame.path,
    relativePath,
    kind: 'file'
  }
  const line = Math.max(1, frame.line)
  await revealLocation(node, line, Math.max(1, frame.column))
  setCurrentExecutionLine(relativePath, line)
}

/* -------------------------------------------------------------------------- */
/*  Fetching                                                                   */
/* -------------------------------------------------------------------------- */

async function refreshThreads(): Promise<void> {
  const result = await window.betterCallCompiler.dap.threads({})
  threads = result.ok ? result.value.threads : []
  render()
}

/** Scopes that are not `expensive` are opened by default — the same hint DAP defines it for. */
function seedScopeExpansion(): void {
  for (const scope of scopes) {
    if (!scope.expensive) {
      expandedRefs.add(scope.variablesReference)
      void loadVariables(scope.variablesReference)
    }
  }
}

async function refreshScopes(frameId: number): Promise<void> {
  const result = await window.betterCallCompiler.dap.scopes({ frameId })
  scopes = result.ok ? result.value.scopes : []
  seedScopeExpansion()
  render()
}

async function refreshStack(threadId: number): Promise<void> {
  const result = await window.betterCallCompiler.dap.stackTrace({ threadId })
  frames = result.ok ? result.value.frames : []
  selectedFrameId = frames[0]?.id ?? null
  scopes = []
  variableCache.clear()
  expandedRefs.clear()
  render()

  const top = frames[0]
  if (top !== undefined) {
    void revealFrame(top)
    void refreshScopes(top.id)
  }
}

async function loadVariables(reference: number): Promise<void> {
  const result = await window.betterCallCompiler.dap.variables({ variablesReference: reference })
  variableCache.set(reference, result.ok ? [...result.value.variables] : [])
  render()
}

function selectFrame(frame: DapStackFrameRecord): void {
  if (frame.id === selectedFrameId) return
  selectedFrameId = frame.id
  scopes = []
  variableCache.clear()
  expandedRefs.clear()
  render()
  void revealFrame(frame)
  void refreshScopes(frame.id)
}

/* -------------------------------------------------------------------------- */
/*  Session state                                                             */
/* -------------------------------------------------------------------------- */

function applyStatus(next: DapSessionStatusRecord | null): void {
  status = next

  if (next === null) {
    threads = []
    frames = []
    selectedFrameId = null
    scopes = []
    variableCache.clear()
    expandedRefs.clear()
    setCurrentExecutionLine(null, null)
    render()
    return
  }

  if (next.state === 'stopped' && next.threadId !== null) {
    void refreshThreads()
    void refreshStack(next.threadId)
  } else if (next.state === 'running' || next.state === 'starting') {
    frames = []
    selectedFrameId = null
    scopes = []
    variableCache.clear()
    expandedRefs.clear()
    setCurrentExecutionLine(null, null)
  }

  render()
}

function appendOutput(payload: DapOutputRecord): void {
  output.push(payload)
  if (output.length > MAX_OUTPUT_LINES) output.splice(0, output.length - MAX_OUTPUT_LINES)
  render()
}

/** Wired once at boot — see the file-level note on why this is not `mountDebug`. */
export function initDebugListeners(): void {
  if (listenersWired) return
  listenersWired = true

  window.betterCallCompiler.dap.onStatusChanged((next) => applyStatus(next))
  window.betterCallCompiler.dap.onOutput((payload) => appendOutput(payload))
  window.betterCallCompiler.dap.onNotice((payload) => notify(payload.message, 'warning', 8_000))
}

/* -------------------------------------------------------------------------- */
/*  Actions — shared by this view's buttons, the command palette, and F5      */
/* -------------------------------------------------------------------------- */

export function isDebugging(): boolean {
  return status !== null
}

export async function startDebugActiveFile(): Promise<void> {
  const doc = activeDocument()
  if (doc === null) {
    notify('Open a file to debug it.', 'warning')
    return
  }

  output = []
  render()

  const result = await window.betterCallCompiler.dap.start({
    relativePath: doc.node.relativePath,
    languageId: languageForFile(doc.node.name)
  })
  if (!result.ok) {
    notifyError(`Could not start debugging: ${result.error.message}`)
    return
  }
  applyStatus(result.value.session)
}

export async function continueDebugging(): Promise<void> {
  await window.betterCallCompiler.dap.continue({})
}
export async function stepOverDebugging(): Promise<void> {
  await window.betterCallCompiler.dap.stepOver({})
}
export async function stepIntoDebugging(): Promise<void> {
  await window.betterCallCompiler.dap.stepIn({})
}
export async function stepOutDebugging(): Promise<void> {
  await window.betterCallCompiler.dap.stepOut({})
}
export async function stepBackDebugging(): Promise<void> {
  await window.betterCallCompiler.dap.stepBack({})
}
export async function pauseDebugging(): Promise<void> {
  await window.betterCallCompiler.dap.pause({})
}
export async function stopDebugging(): Promise<void> {
  await window.betterCallCompiler.dap.stop({})
}

/* -------------------------------------------------------------------------- */
/*  Rendering                                                                  */
/* -------------------------------------------------------------------------- */

function iconButton(
  label: string,
  title: string,
  onClick: () => void,
  disabled = false
): HTMLButtonElement {
  const button = el('button', 'icon-button debug-controls__button', label)
  button.type = 'button'
  button.title = title
  button.setAttribute('aria-label', title)
  button.disabled = disabled
  button.addEventListener('click', onClick)
  return button
}

function renderControls(): HTMLElement {
  const bar = el('div', 'debug-controls')
  const stopped = status?.state === 'stopped'

  if (status === null) {
    bar.append(iconButton('▶', 'Start Debugging (F5)', () => void startDebugActiveFile()))
    return bar
  }

  bar.append(iconButton('▶', 'Continue', () => void continueDebugging(), !stopped))
  bar.append(iconButton('⤵', 'Step Over', () => void stepOverDebugging(), !stopped))
  bar.append(iconButton('⤷', 'Step Into', () => void stepIntoDebugging(), !stopped))
  bar.append(iconButton('⤴', 'Step Out', () => void stepOutDebugging(), !stopped))
  if (status.supportsStepBack) {
    bar.append(iconButton('⟲', 'Step Back', () => void stepBackDebugging(), !stopped))
  }
  bar.append(iconButton('⏸', 'Pause', () => void pauseDebugging(), stopped))
  bar.append(iconButton('■', 'Stop', () => void stopDebugging()))
  return bar
}

function renderStatusLine(): HTMLElement {
  const line = el('div', 'debug-status')
  if (status === null) {
    line.textContent = 'Not debugging.'
    return line
  }

  const parts = [status.adapterId, status.relativePath, status.state]
  if (status.threadId !== null) {
    const thread = threads.find((candidate) => candidate.id === status?.threadId)
    if (thread !== undefined) parts.push(thread.name)
  }
  if (status.state === 'stopped' && status.stoppedReason !== null) {
    parts.push(`(${status.stoppedReason})`)
  }
  line.textContent = parts.join(' — ')
  return line
}

function renderSection(title: string, body: HTMLElement, extraClass = ''): HTMLElement {
  const section = el('div', `debug-section${extraClass === '' ? '' : ` ${extraClass}`}`)
  section.append(el('div', 'debug-section__title', title))
  section.append(body)
  return section
}

function renderCallStack(): HTMLElement {
  const list = el('div', 'debug-list')

  if (frames.length === 0) {
    list.append(
      el('p', 'explorer__empty-text', status?.state === 'stopped' ? 'No stack.' : 'Not stopped.')
    )
    return renderSection('Call Stack', list)
  }

  for (const frame of frames) {
    const row = el(
      'div',
      `debug-list__row${frame.id === selectedFrameId ? ' debug-list__row--active' : ''}`
    )
    row.setAttribute('role', 'button')
    row.tabIndex = 0
    row.append(el('span', 'debug-list__label', frame.name))
    if (frame.path !== null) {
      row.append(el('span', 'debug-list__detail', `${basenameOf(frame.path)}:${frame.line}`))
    }
    const go = (): void => selectFrame(frame)
    row.addEventListener('click', go)
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        go()
      }
    })
    list.append(row)
  }

  return renderSection('Call Stack', list)
}

function renderVariableNode(variable: DapVariableRecord, depth: number): HTMLElement {
  const wrap = el('div', 'debug-var')
  const expandable = variable.variablesReference !== 0
  const expanded = expandable && expandedRefs.has(variable.variablesReference)

  const header = el('div', 'debug-var__row')
  header.style.paddingLeft = `${depth * 12}px`

  if (expandable) {
    header.setAttribute('role', 'button')
    header.tabIndex = 0
    header.append(el('span', `debug-var__chevron${expanded ? ' debug-var__chevron--open' : ''}`, '›'))
    const toggle = (): void => {
      if (expanded) expandedRefs.delete(variable.variablesReference)
      else {
        expandedRefs.add(variable.variablesReference)
        if (!variableCache.has(variable.variablesReference)) void loadVariables(variable.variablesReference)
      }
      render()
    }
    header.addEventListener('click', toggle)
    header.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        toggle()
      }
    })
  } else {
    header.append(el('span', 'debug-var__chevron debug-var__chevron--leaf'))
  }

  header.append(el('span', 'debug-var__name', variable.name))
  if (variable.value !== '') header.append(el('span', 'debug-var__value', variable.value))
  if (variable.type !== null) header.title = variable.type
  wrap.append(header)

  if (expandable && expanded) {
    const children = variableCache.get(variable.variablesReference)
    if (children === undefined) {
      const loading = el('p', 'debug-var__loading', 'Loading…')
      loading.style.paddingLeft = `${(depth + 1) * 12}px`
      wrap.append(loading)
    } else {
      for (const child of children) wrap.append(renderVariableNode(child, depth + 1))
    }
  }

  return wrap
}

function renderVariables(): HTMLElement {
  const list = el('div', 'debug-list debug-list--tree')

  if (scopes.length === 0) {
    list.append(el('p', 'explorer__empty-text', 'Not stopped.'))
    return renderSection('Variables', list)
  }

  for (const scope of scopes) {
    list.append(
      renderVariableNode(
        { name: scope.name, value: '', type: null, variablesReference: scope.variablesReference },
        0
      )
    )
  }

  return renderSection('Variables', list)
}

async function openBreakpointLocation(relativePath: string, line: number): Promise<void> {
  const absolute = absolutePathFor(relativePath)
  if (absolute === null) return
  const node: FileNode = { name: basenameOf(relativePath), path: absolute, relativePath, kind: 'file' }
  await revealLocation(node, line, 1)
}

function renderBreakpoints(): HTMLElement {
  const list = el('div', 'debug-list')
  const entries = [...allBreakpoints().entries()].sort(([a], [b]) => a.localeCompare(b))

  if (entries.length === 0) {
    list.append(
      el('p', 'explorer__empty-text', 'No breakpoints. Click a line number in the editor to add one.')
    )
    return renderSection('Breakpoints', list)
  }

  for (const [relativePath, lines] of entries) {
    for (const line of lines) {
      const row = el('div', 'debug-list__row')
      row.setAttribute('role', 'button')
      row.tabIndex = 0
      row.title = relativePath
      row.append(el('span', 'debug-list__label', `${basenameOf(relativePath)}:${line}`))

      const remove = el('button', 'icon-button debug-list__remove', '×')
      remove.type = 'button'
      remove.title = 'Remove breakpoint'
      remove.setAttribute('aria-label', `Remove breakpoint at ${relativePath}:${line}`)
      remove.addEventListener('click', (event) => {
        event.stopPropagation()
        void clearBreakpoint(relativePath, line).then(render)
      })
      row.append(remove)

      const go = (): void => void openBreakpointLocation(relativePath, line)
      row.addEventListener('click', go)
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          go()
        }
      })
      list.append(row)
    }
  }

  return renderSection('Breakpoints', list)
}

function renderOutput(): HTMLElement {
  const list = el('div', 'debug-output')
  for (const entry of output.slice(-500)) {
    list.append(el('div', `debug-output__line debug-output__line--${entry.category}`, entry.text))
  }
  return renderSection('Debug Console', list, 'debug-section--output')
}

function render(): void {
  if (bodyHost === null) return

  bodyHost.replaceChildren()
  bodyHost.append(renderControls())
  bodyHost.append(renderStatusLine())
  bodyHost.append(renderCallStack())
  bodyHost.append(renderVariables())
  bodyHost.append(renderBreakpoints())
  const outputSection = renderOutput()
  bodyHost.append(outputSection)

  const outputList = outputSection.querySelector('.debug-output')
  if (outputList !== null) outputList.scrollTop = outputList.scrollHeight
}

export function mountDebug(_title: HTMLElement, body: HTMLElement): void {
  bodyHost = body
  render()
}

export function onDebugShown(): void {
  render()
}
