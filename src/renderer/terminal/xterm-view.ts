import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { describeExit, type TerminalSession } from '../../shared/types'
import { notifyError } from '../workbench/notifications'

/**
 * xterm.js views over main-process PTYs.
 *
 * Two coalescing layers keep a verbose build from melting the UI: main batches
 * PTY chunks on a short timer before they cross IPC, and each view here buffers
 * again until the next animation frame. Writing to xterm once per frame instead
 * of once per chunk is the difference between a smooth scroll and a locked-up
 * renderer.
 */
interface View {
  readonly session: TerminalSession
  readonly terminal: Terminal
  readonly fit: FitAddon
  readonly host: HTMLElement
  readonly resizeObserver: ResizeObserver
  /** Output waiting for the next frame. */
  pending: string[]
  frame: number | null
  /** Input waiting to be sent to the PTY. */
  outbound: string
  outboundTimer: number | null
  exited: boolean
}

const views = new Map<string, View>()
let activeId: string | null = null
let container: HTMLElement | null = null
let tabStrip: HTMLElement | null = null
let listenersBound = false

const THEME = {
  background: '#16181d',
  foreground: '#d7dae0',
  cursor: '#4c9df3',
  cursorAccent: '#16181d',
  selectionBackground: '#2d3b52',
  black: '#1b1d23',
  red: '#f0616d',
  green: '#4ec97a',
  yellow: '#e0b341',
  blue: '#4c9df3',
  magenta: '#c586c0',
  cyan: '#3fc7c7',
  white: '#d7dae0',
  brightBlack: '#6d7481',
  brightRed: '#ff7b85',
  brightGreen: '#6fdc95',
  brightYellow: '#f0c75e',
  brightBlue: '#6bb0f7',
  brightMagenta: '#d7a3e0',
  brightCyan: '#5ddede',
  brightWhite: '#ffffff'
}

function flushPending(view: View): void {
  view.frame = null
  if (view.pending.length === 0) return
  const chunk = view.pending.join('')
  view.pending = []
  view.terminal.write(chunk)
}

function scheduleWrite(view: View, data: string): void {
  view.pending.push(data)
  if (view.frame !== null) return
  view.frame = window.requestAnimationFrame(() => flushPending(view))
}

/** Keystrokes are tiny but a paste is not; batching keeps IPC calls proportional. */
function scheduleInput(view: View, data: string): void {
  view.outbound += data
  if (view.outboundTimer !== null) return
  view.outboundTimer = window.setTimeout(() => {
    view.outboundTimer = null
    const payload = view.outbound
    view.outbound = ''
    if (payload === '') return
    void window.betterCallCompiler.terminal.write({ id: view.session.id, data: payload })
  }, 4)
}

function bindGlobalListeners(): void {
  if (listenersBound) return
  listenersBound = true

  window.betterCallCompiler.terminal.onData(({ id, data }) => {
    const view = views.get(id)
    if (view !== undefined) scheduleWrite(view, data)
  })

  window.betterCallCompiler.terminal.onExit(({ id, exitCode }) => {
    const view = views.get(id)
    if (view === undefined) return
    view.exited = true
    flushPending(view)
    view.terminal.write(`\r\n\x1b[2m[process ${describeExit(exitCode)}]\x1b[0m\r\n`)
    renderTabs()
  })
}

function applyFit(view: View): void {
  if (view.host.clientWidth === 0 || view.host.clientHeight === 0) return
  try {
    view.fit.fit()
  } catch {
    return
  }
  if (view.exited) return
  void window.betterCallCompiler.terminal.resize({
    id: view.session.id,
    cols: view.terminal.cols,
    rows: view.terminal.rows
  })
}

export async function createTerminal(): Promise<void> {
  if (container === null) return
  bindGlobalListeners()

  const host = document.createElement('div')
  host.className = 'terminal-instance'
  container.append(host)

  const terminal = new Terminal({
    fontFamily: 'Cascadia Code, Cascadia Mono, Consolas, monospace',
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 5000,
    theme: THEME,
    allowProposedApi: true
  })

  const fit = new FitAddon()
  terminal.loadAddon(fit)
  terminal.open(host)

  // Fit before asking main for a PTY so the shell starts at the right size and
  // never has to reflow its first prompt.
  try {
    fit.fit()
  } catch {
    // Host not laid out yet; the ResizeObserver will correct it.
  }

  const created = await window.betterCallCompiler.terminal.create({
    cols: terminal.cols,
    rows: terminal.rows
  })

  if (!created.ok) {
    notifyError(`Could not start a terminal: ${created.error.message}`)
    terminal.dispose()
    host.remove()
    return
  }

  const session = created.value.session

  const resizeObserver = new ResizeObserver(() => {
    const view = views.get(session.id)
    if (view !== undefined && activeId === session.id) applyFit(view)
  })
  resizeObserver.observe(host)

  const view: View = {
    session,
    terminal,
    fit,
    host,
    resizeObserver,
    pending: [],
    frame: null,
    outbound: '',
    outboundTimer: null,
    exited: false
  }

  terminal.onData((data) => scheduleInput(view, data))

  views.set(session.id, view)
  activate(session.id)
  renderTabs()
}

export function activate(id: string): void {
  const view = views.get(id)
  if (view === undefined) return

  activeId = id
  for (const [otherId, other] of views) {
    other.host.hidden = otherId !== id
  }

  applyFit(view)
  view.terminal.focus()
  renderTabs()
}

export function closeTerminal(id: string): void {
  const view = views.get(id)
  if (view === undefined) return

  view.resizeObserver.disconnect()
  if (view.frame !== null) cancelAnimationFrame(view.frame)
  if (view.outboundTimer !== null) clearTimeout(view.outboundTimer)

  // Order matters: stop the PTY first, then tear the view down, so late data
  // cannot arrive for a disposed terminal.
  void window.betterCallCompiler.terminal.dispose({ id })
  view.terminal.dispose()
  view.host.remove()
  views.delete(id)

  if (activeId === id) {
    activeId = null
    const next = [...views.keys()][0]
    if (next !== undefined) activate(next)
  }
  renderTabs()
}

function renderTabs(): void {
  if (tabStrip === null) return
  tabStrip.replaceChildren()

  for (const view of views.values()) {
    const tab = document.createElement('button')
    tab.type = 'button'
    tab.className = `panel-tab${view.session.id === activeId ? ' panel-tab--active' : ''}`
    tab.dataset['sessionId'] = view.session.id
    tab.textContent = view.exited ? `${view.session.shellName} (exited)` : view.session.shellName
    tab.addEventListener('click', () => activate(view.session.id))
    tabStrip.append(tab)
  }

  const add = document.createElement('button')
  add.type = 'button'
  add.className = 'icon-button'
  add.title = 'New Terminal'
  add.setAttribute('aria-label', 'New Terminal')
  add.innerHTML =
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" fill="none" ' +
    'stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>'
  add.addEventListener('click', () => void createTerminal())
  tabStrip.append(add)

  if (activeId !== null) {
    const kill = document.createElement('button')
    kill.type = 'button'
    kill.className = 'icon-button'
    kill.title = 'Close Terminal'
    kill.setAttribute('aria-label', 'Close Terminal')
    kill.innerHTML =
      '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" ' +
      'stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>'
    const target = activeId
    kill.addEventListener('click', () => closeTerminal(target))
    tabStrip.append(kill)
  }
}

export function hasTerminals(): boolean {
  return views.size > 0
}

export function refitActive(): void {
  if (activeId === null) return
  const view = views.get(activeId)
  if (view !== undefined) applyFit(view)
}

export function mountTerminals(host: HTMLElement, tabs: HTMLElement): void {
  container = host
  tabStrip = tabs
  renderTabs()
}
