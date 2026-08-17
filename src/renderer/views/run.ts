import { Terminal, type IDisposable, type ILink } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { findErrorLinks, isAbsoluteLike } from '../../shared/error-links'
import type { FileNode, RunExit, RunStarted, Workspace } from '../../shared/types'
import { activeDocument, revealLocation } from '../editor/models'
import { languageForFile } from '../editor/language-id'
import { notify, notifyError } from '../workbench/notifications'
import { packById, type PackContext } from '../bundled-packs/web'

/**
 * The output console.
 *
 * Rendered through xterm.js rather than a hand-rolled `<pre>`, which is what
 * makes ANSI colour, carriage returns and progress bars work without writing a
 * terminal emulator. The M1 console is a *streaming output view*, not a debug
 * session — the debugger is M2 — and the banner says so rather than implying a
 * capability that is not there.
 */

const THEME = {
  background: '#16181d',
  foreground: '#d7dae0',
  cursor: '#16181d',
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

let terminal: Terminal | null = null
let fit: FitAddon | null = null
let consoleHost: HTMLElement | null = null
let bannerHost: HTMLElement | null = null
let previewHost: HTMLElement | null = null
let actionsHost: HTMLElement | null = null
let runButton: HTMLButtonElement | null = null
let cancelButton: HTMLButtonElement | null = null

let currentRunId: string | null = null
let workspace: Workspace = { root: null, name: null }
let listenersBound = false
let linkProvider: IDisposable | null = null

/** Output waiting for the next frame — same coalescing the terminal view uses. */
let pending: string[] = []
let frame: number | null = null

function flush(): void {
  frame = null
  if (pending.length === 0) return
  // Deliberately keeps `pending` when there is no terminal yet: the console is
  // created lazily, and dropping buffered output here would lose the start of a
  // run that began before the view was ever shown.
  if (terminal === null) return
  const chunk = pending.join('')
  pending = []
  terminal.write(chunk)
}

function scheduleWrite(data: string): void {
  pending.push(data)
  if (frame !== null) return
  frame = window.requestAnimationFrame(flush)
}

/* ------------------------------ error links ------------------------------ */

/**
 * Resolves a path as a tool printed it into something the editor can open.
 *
 * Compilers report paths relative to their working directory, which is the
 * workspace root — the same root `fs:readFile` confines against, so a link that
 * resolves outside it simply fails to open rather than reaching off-workspace.
 */
function nodeForPath(printed: string): FileNode | null {
  if (workspace.root === null) return null

  const normalized = printed.replace(/\\/g, '/')
  const absolute = isAbsoluteLike(printed)
    ? normalized
    : `${workspace.root.replace(/\\/g, '/').replace(/\/+$/, '')}/${normalized.replace(/^\.\//, '')}`

  const root = workspace.root.replace(/\\/g, '/').replace(/\/+$/, '')
  const relativePath = absolute.toLowerCase().startsWith(`${root.toLowerCase()}/`)
    ? absolute.slice(root.length + 1)
    : absolute

  const name = absolute.slice(absolute.lastIndexOf('/') + 1)
  return { name, path: absolute, relativePath, kind: 'file' }
}

/**
 * Registers the link provider that turns `file:line:col` into a click target.
 *
 * xterm asks one *rendered* buffer line at a time, so the regexes run against
 * what is on screen rather than against the chunks that arrived over IPC. A
 * location split across a wrap boundary is therefore not linkified; that is a
 * known limitation, not a silent failure — the text is still readable.
 */
function registerLinks(term: Terminal): void {
  linkProvider?.dispose()
  linkProvider = term.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const line = term.buffer.active.getLine(bufferLineNumber - 1)
      if (line === undefined) {
        callback(undefined)
        return
      }

      const text = line.translateToString(true)
      const found = findErrorLinks(text)
      if (found.length === 0) {
        callback(undefined)
        return
      }

      const links: ILink[] = found.map((link) => ({
        // xterm columns are 1-based and the range end is inclusive.
        range: {
          start: { x: link.start + 1, y: bufferLineNumber },
          end: { x: Math.min(link.end, text.length), y: bufferLineNumber }
        },
        text: text.slice(link.start, link.end),
        activate: () => {
          const node = nodeForPath(link.path)
          if (node === null) return
          void revealLocation(node, link.line, link.column).then((ok) => {
            if (!ok) notifyError(`Could not open ${link.path}`)
          })
        }
      }))

      callback(links)
    }
  })
}

/* -------------------------------- banner --------------------------------- */

function renderBanner(started: RunStarted | null): void {
  if (bannerHost === null) return
  bannerHost.replaceChildren()

  if (started === null) {
    bannerHost.hidden = true
    return
  }

  bannerHost.hidden = false
  bannerHost.className = `run-banner run-banner--${started.mode}`

  const badge = document.createElement('span')
  badge.className = 'run-banner__badge'
  badge.textContent =
    started.mode === 'real' ? 'toolchain' : started.mode === 'bundled' ? 'bundled' : 'unavailable'
  bannerHost.append(badge)

  const text = document.createElement('span')
  text.className = 'run-banner__text'

  if (started.mode === 'real') {
    // Show the exact argv. A user debugging "why did it pick that Python" needs
    // the resolved path, not the word "python".
    text.textContent = `${started.command ?? ''} ${started.args.join(' ')}`.trim()
    text.title = text.textContent
  } else {
    text.textContent = started.reason ?? ''
  }
  bannerHost.append(text)
}

/* ------------------------------- execution ------------------------------- */

function setBusy(busy: boolean): void {
  if (runButton !== null) runButton.disabled = busy
  if (cancelButton !== null) cancelButton.hidden = !busy
}

function writeSummary(code: number | null, durationMs: number, cancelled: boolean): void {
  const seconds = durationMs >= 1000 ? `${(durationMs / 1000).toFixed(2)}s` : `${durationMs}ms`
  const verdict = cancelled
    ? '\x1b[33mcancelled\x1b[0m'
    : code === 0
      ? '\x1b[32mexited cleanly\x1b[0m'
      : `\x1b[31mexited with code ${code ?? 'unknown'}\x1b[0m`
  scheduleWrite(`\r\n\x1b[2m[${verdict}\x1b[2m · ${seconds}]\x1b[0m\r\n`)
}

/**
 * Output that arrived before the renderer learned which run it belongs to.
 *
 * Main spawns the child as soon as `run:start` is handled and returns the
 * decision separately, so a process that prints immediately can beat the invoke
 * response back across IPC. Matching strictly on `currentRunId` would silently
 * drop those first chunks — for a short script, that is the entire output.
 * Anything for an unrecognised run is parked here and drained the moment the id
 * is known; whatever is never claimed is discarded on the next run.
 */
interface PendingRun {
  output: string[]
  exit: RunExit | null
}

const parked = new Map<string, PendingRun>()

function parkedFor(runId: string): PendingRun {
  let entry = parked.get(runId)
  if (entry === undefined) {
    entry = { output: [], exit: null }
    parked.set(runId, entry)
  }
  return entry
}

function completeRun(exit: RunExit): void {
  flush()
  writeSummary(exit.code, exit.durationMs, exit.cancelled)
  currentRunId = null
  setBusy(false)
}

/** Called once the invoke response tells us which run we are watching. */
function adoptRun(runId: string): void {
  currentRunId = runId

  const entry = parked.get(runId)
  if (entry === undefined) return
  parked.delete(runId)

  for (const chunk of entry.output) scheduleWrite(chunk)
  if (entry.exit !== null) completeRun(entry.exit)
}

function bindRunEvents(): void {
  if (listenersBound) return
  listenersBound = true

  const onOutput = (payload: { runId: string; data: string }): void => {
    if (payload.runId === currentRunId) {
      scheduleWrite(payload.data)
      return
    }
    // Either output that beat the response back, or a late chunk from a
    // cancelled run. Park it; only the former is ever claimed.
    parkedFor(payload.runId).output.push(payload.data)
  }

  window.betterCallCompiler.run.onStdout(onOutput)
  window.betterCallCompiler.run.onStderr(onOutput)

  window.betterCallCompiler.run.onExit((payload) => {
    if (payload.runId === currentRunId) {
      completeRun(payload)
      return
    }
    parkedFor(payload.runId).exit = payload
  })
}

async function refreshWorkspace(): Promise<void> {
  const result = await window.betterCallCompiler.fs.getWorkspace({})
  if (result.ok) workspace = result.value
}

function clearConsole(): void {
  pending = []
  terminal?.reset()
  if (previewHost !== null) {
    previewHost.replaceChildren()
    previewHost.hidden = true
  }
}

/**
 * Runs a file. Exported so `Ctrl+F5`, the panel button and — later — the command
 * palette all land on one code path.
 */
export async function runFile(node: FileNode): Promise<void> {
  if (currentRunId !== null) {
    notify('A run is already in progress.', 'warning')
    return
  }

  await refreshWorkspace()
  clearConsole()
  setBusy(true)

  // Anything still parked belongs to a run nobody is watching any more.
  parked.clear()

  const languageId = languageForFile(node.name)
  const started = await window.betterCallCompiler.run.start({ path: node.path, languageId })

  if (!started.ok) {
    setBusy(false)
    renderBanner(null)
    scheduleWrite(`\x1b[31m${started.error.message}\x1b[0m\r\n`)
    return
  }

  const run = started.value.run
  renderBanner(run)
  scheduleWrite(`\x1b[2m${run.relativePath}\x1b[0m\r\n`)

  if (run.mode === 'real') {
    // Output arrives as events; the exit handler clears the busy state. Adopting
    // rather than assigning drains anything that beat this response back.
    adoptRun(run.runId)
    return
  }

  if (run.mode === 'unsupported') {
    scheduleWrite(`\x1b[33m${run.reason ?? 'Nothing can run this file.'}\x1b[0m\r\n`)
    setBusy(false)
    return
  }

  // Bundled: main made the decision, the renderer carries it out.
  const pack = run.pack === null ? null : packById(run.pack)
  if (pack === null) {
    scheduleWrite(`\x1b[31mNo bundled runtime "${run.pack ?? '?'}" is installed.\x1b[0m\r\n`)
    setBusy(false)
    return
  }

  const context: PackContext = {
    filePath: run.filePath,
    relativePath: run.relativePath,
    write: (stream, text) => {
      const body = text.replace(/\r?\n/g, '\r\n')
      scheduleWrite(stream === 'stderr' ? `\x1b[31m${body}\x1b[0m` : body)
    },
    preview: previewHost ?? document.createElement('div')
  }

  const startedAt = Date.now()
  let code = 1
  try {
    code = await pack.run(context)
  } catch (error) {
    context.write('stderr', `${error instanceof Error ? error.message : 'pack failed'}\n`)
  }
  flush()
  writeSummary(code, Date.now() - startedAt, false)
  setBusy(false)
}

/** Runs whatever is in the active editor tab. */
export async function runActiveFile(): Promise<void> {
  const doc = activeDocument()
  if (doc === null) {
    notify('Open a file to run it.', 'warning')
    return
  }
  await runFile(doc.node)
}

export async function cancelActiveRun(): Promise<void> {
  if (currentRunId === null) return
  await window.betterCallCompiler.run.cancel({ runId: currentRunId })
}

export function isRunning(): boolean {
  return currentRunId !== null
}

/**
 * Creates the console on first use.
 *
 * Built lazily rather than at mount for two reasons. It keeps a second xterm
 * instance — with its own renderer, canvas and event handlers — out of the
 * document for every session that never runs anything, which is most of them.
 * And it keeps `.xterm` unambiguous while the panel is on the terminal view,
 * which is what step 5's E2E assertions rely on.
 */
function ensureTerminal(): Terminal | null {
  if (terminal !== null) return terminal
  if (consoleHost === null) return null

  terminal = new Terminal({
    fontFamily: 'Cascadia Code, Cascadia Mono, Consolas, monospace',
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: false,
    // The console is read-only; a blinking cursor implies an input it does not
    // accept. Keystrokes go nowhere because nothing is wired to onData.
    disableStdin: true,
    scrollback: 10_000,
    theme: THEME,
    allowProposedApi: true
  })

  fit = new FitAddon()
  terminal.loadAddon(fit)
  terminal.open(consoleHost)
  registerLinks(terminal)

  // Anything buffered while the console did not exist belongs on screen now.
  flush()
  return terminal
}

/**
 * Refits an existing console. Deliberately does *not* create one — a
 * `ResizeObserver` fires once as soon as it starts observing, so building the
 * terminal here would defeat the laziness above and put a second xterm in the
 * document at boot after all.
 */
export function refitOutput(): void {
  if (terminal === null || fit === null || consoleHost === null) return
  if (consoleHost.clientWidth === 0 || consoleHost.clientHeight === 0) return
  try {
    fit.fit()
  } catch {
    // Host not laid out yet.
  }
}

/* --------------------------------- mount --------------------------------- */

function iconButton(label: string, path: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'icon-button'
  button.title = label
  button.setAttribute('aria-label', label)
  button.innerHTML =
    `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${path}" fill="none" ` +
    `stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`
  button.addEventListener('click', onClick)
  return button
}

export function mountRunView(body: HTMLElement, actions: HTMLElement): void {
  actionsHost = actions

  const banner = document.createElement('div')
  banner.className = 'run-banner'
  banner.id = 'run-banner'
  banner.hidden = true
  bannerHost = banner

  const preview = document.createElement('div')
  preview.className = 'run-preview'
  preview.id = 'run-preview'
  preview.hidden = true
  previewHost = preview

  const host = document.createElement('div')
  host.className = 'run-console'
  host.id = 'run-console'
  consoleHost = host

  body.replaceChildren(banner, preview, host)

  new ResizeObserver(() => refitOutput()).observe(host)

  runButton = document.createElement('button')
  runButton.type = 'button'
  runButton.className = 'button button--primary run-action'
  runButton.textContent = 'Run'
  runButton.title = 'Run the active file (Ctrl+F5)'
  runButton.addEventListener('click', () => void runActiveFile())

  cancelButton = document.createElement('button')
  cancelButton.type = 'button'
  // Deliberately not `button--danger`: that class marks an irreversible
  // destructive action — deleting a file, discarding unsaved edits — and
  // stopping a run is neither. It is also what the explorer's delete dialog is
  // located by in the E2E suite, so borrowing it here would make that locator
  // ambiguous.
  cancelButton.className = 'button run-action run-action--cancel'
  cancelButton.textContent = 'Cancel'
  cancelButton.hidden = true
  cancelButton.addEventListener('click', () => void cancelActiveRun())

  actions.replaceChildren(
    runButton,
    cancelButton,
    iconButton('Clear Output', 'M3 5h10M6 5V3h4v2M5 5l.7 9h4.6L11 5', clearConsole)
  )

  bindRunEvents()
  // Re-read before every run rather than caching once: the workspace can change
  // under us, and a stale root makes every relative path in a stack trace
  // resolve against the previous folder.
  void refreshWorkspace()
}

/** Called when the panel switches to the Output tab — the console's first use. */
export function showRunActions(): void {
  if (actionsHost !== null) actionsHost.hidden = false
  ensureTerminal()
  refitOutput()
}
