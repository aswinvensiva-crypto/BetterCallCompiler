import type { DebugCommandName, DebugExit, DebugState, FileNode } from '../../shared/types'
import { activeDocument } from '../editor/models'
import {
  applyResolved,
  breakpointsFor,
  onBreakpointsChanged,
  setStoppedLine
} from '../editor/breakpoints'
import { notifyError } from '../workbench/notifications'

/**
 * The debugger panel.
 *
 * Controls on the left, three panes on the right: call stack, locals, and the
 * program's output. Everything it shows arrives in ONE `debug:stopped` message,
 * so there is no state here that main does not have — the panel is a renderer
 * for a snapshot, not a model of the session.
 *
 * ## Output is replaced, never appended
 *
 * The run console appends, because a process can only print. This session can
 * step BACKWARDS, which un-prints: stepping back over a `print` has to remove
 * the line. So each snapshot carries the whole transcript and this replaces
 * what is on screen. Appending would leave the undone output visible, which is
 * the one thing reverse debugging must not do.
 *
 * ## The buttons say what is possible
 *
 * Stepping is disabled with no session; Continue and the forward steps stay
 * live after the program ends only because backwards still works from there.
 * A control that looks pressable and does nothing is worse than a greyed one.
 */

let bodyHost: HTMLElement | null = null
let actionsHost: HTMLElement | null = null

let statusEl: HTMLElement | null = null
let stackEl: HTMLElement | null = null
let localsEl: HTMLElement | null = null
let outputEl: HTMLElement | null = null

let startButton: HTMLButtonElement | null = null
let stopButton: HTMLButtonElement | null = null
const stepButtons = new Map<DebugCommandName, HTMLButtonElement>()

let runId: string | null = null
let relativePath: string | null = null
let lastState: DebugState | null = null
let listenersBound = false

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

/* -------------------------------------------------------------------------- */
/*  Rendering                                                                  */
/* -------------------------------------------------------------------------- */

function renderStatus(): void {
  if (statusEl === null) return

  if (runId === null) {
    statusEl.textContent = 'No debug session. Open a .bcc file and press Debug.'
    statusEl.dataset['reason'] = 'idle'
    return
  }

  const state = lastState
  if (state === null) {
    statusEl.textContent = 'Starting…'
    statusEl.dataset['reason'] = 'starting'
    return
  }

  const where = state.stop.line === null ? 'end of program' : `line ${state.stop.line}`
  const detail = state.stop.message === null ? '' : ` — ${state.stop.message}`
  statusEl.textContent = `${state.stop.reason} at ${where}${detail}`
  statusEl.dataset['reason'] = state.stop.reason
}

function renderStack(state: DebugState | null): void {
  if (stackEl === null) return

  const rows = state?.frames ?? []
  if (rows.length === 0) {
    stackEl.replaceChildren(el('div', 'debug-empty', 'No stack.'))
    return
  }

  stackEl.replaceChildren(
    ...rows.map((frame) => {
      const row = el('div', 'debug-frame')
      row.dataset['frameId'] = String(frame.id)
      row.append(el('span', 'debug-frame__name', frame.name))
      row.append(el('span', 'debug-frame__line', `${frame.source?.path ?? '?'}:${frame.line}`))
      return row
    })
  )
}

function renderLocals(state: DebugState | null): void {
  if (localsEl === null) return

  // The innermost frame's locals. A tree with one expandable node per frame
  // would be more DAP-shaped, but BCC has no closures and stacks of two, so it
  // would be an outline around the one thing anyone looks at.
  const innermost = state?.frames[0]
  const scope = innermost === undefined
    ? undefined
    : state?.locals.find((entry) => entry.frameId === innermost.id)

  const variables = scope?.variables ?? []
  if (variables.length === 0) {
    localsEl.replaceChildren(el('div', 'debug-empty', 'No locals.'))
    return
  }

  localsEl.replaceChildren(
    ...variables.map((variable) => {
      const row = el('div', 'debug-variable')
      row.dataset['name'] = variable.name
      row.append(el('span', 'debug-variable__name', variable.name))
      row.append(el('span', 'debug-variable__value', variable.value))
      return row
    })
  )
}

function renderOutput(text: string): void {
  if (outputEl === null) return
  // `textContent`, not `innerHTML`: a program prints whatever it likes and this
  // is the one place its bytes reach the DOM.
  outputEl.textContent = text
}

function renderButtons(): void {
  const live = runId !== null
  startButton?.toggleAttribute('disabled', live)
  stopButton?.toggleAttribute('disabled', !live)
  for (const button of stepButtons.values()) button.toggleAttribute('disabled', !live)
}

function renderAll(): void {
  renderStatus()
  renderStack(lastState)
  renderLocals(lastState)
  renderOutput(lastState?.output ?? '')
  renderButtons()
}

/* -------------------------------------------------------------------------- */
/*  Driving                                                                    */
/* -------------------------------------------------------------------------- */

function onStopped(state: DebugState): void {
  if (state.runId !== runId) return
  lastState = state

  /*
   * Move the dots to where the session really put them. A breakpoint dropped on
   * a comment resolved to the next line with code, and leaving the dot where it
   * was clicked would show a breakpoint that is not there.
   */
  if (relativePath !== null) {
    const lines = state.breakpoints
      .map((breakpoint) => breakpoint.line)
      .filter((line): line is number => line !== undefined)
    applyResolved(relativePath, lines)
  }

  setStoppedLine(relativePath, state.stop.line)
  renderAll()
}

function onExited(exit: DebugExit): void {
  if (exit.runId !== runId) return

  const message = exit.message.trim()
  runId = null
  lastState = null
  setStoppedLine(null, null)
  renderAll()

  if (statusEl !== null) {
    // A compile error is the session's whole story, so it goes where the state
    // would have: an empty stack beside a silent status bar would look like a
    // debugger that simply did not start.
    statusEl.textContent =
      message === '' ? 'Session ended.' : `Could not start: ${message.split('\n')[0] ?? message}`
    statusEl.dataset['reason'] = message === '' ? 'ended' : 'error'
  }
  if (message !== '') renderOutput(message)
}

function bindListeners(): void {
  if (listenersBound) return
  listenersBound = true
  window.betterCallCompiler.debug.onStopped(onStopped)
  window.betterCallCompiler.debug.onExited(onExited)

  /*
   * A breakpoint set while the program is PAUSED has to reach the session
   * before the next Continue, or execution runs straight past the dot the user
   * just placed. Subscribing here rather than in `startDebugging` means the
   * subscription is made once, and `syncBreakpoints` is a no-op with no
   * session — which is every click before the first Debug.
   */
  onBreakpointsChanged(() => void syncBreakpoints())
}

async function send(command: DebugCommandName): Promise<void> {
  if (runId === null) return
  await window.betterCallCompiler.debug.command({ runId, command })
}

export async function startDebugging(): Promise<void> {
  const doc = activeDocument()
  if (doc === null) {
    notifyError('Open a file to debug.')
    return
  }

  bindListeners()

  const node: FileNode = doc.node
  const result = await window.betterCallCompiler.debug.start({ path: node.path })
  if (!result.ok) {
    notifyError(result.error.message)
    return
  }

  runId = result.value.session.runId
  relativePath = result.value.session.relativePath
  lastState = null
  renderAll()

  // The dots the user already placed. Sent after the session exists rather than
  // with the start request, so the answer — which says where each one really
  // landed — comes back on the same channel as every other state change.
  const lines = breakpointsFor(relativePath)
  if (lines.length > 0) {
    await window.betterCallCompiler.debug.setBreakpoints({ runId, lines })
  }
}

export async function stopDebugging(): Promise<void> {
  if (runId === null) return
  await window.betterCallCompiler.debug.stop({ runId })
}

/** Whether a session is live. Used by the command palette's enablement. */
export function isDebugging(): boolean {
  return runId !== null
}

/**
 * Push the editor's breakpoints at the live session.
 *
 * Called when the user clicks the gutter mid-session: a breakpoint set while
 * the program is paused has to be armed before the next Continue, or it will be
 * run straight past.
 */
export async function syncBreakpoints(): Promise<void> {
  if (runId === null || relativePath === null) return
  await window.betterCallCompiler.debug.setBreakpoints({
    runId,
    lines: breakpointsFor(relativePath)
  })
}

/* -------------------------------------------------------------------------- */
/*  Mounting                                                                   */
/* -------------------------------------------------------------------------- */

const STEPS: readonly {
  readonly command: DebugCommandName
  readonly label: string
  readonly title: string
}[] = [
  { command: 'continue', label: 'Continue', title: 'Run to the next breakpoint' },
  { command: 'stepOver', label: 'Step Over', title: 'One line, without entering a call' },
  { command: 'stepInto', label: 'Step Into', title: 'One line, entering a call' },
  { command: 'stepOut', label: 'Step Out', title: 'Run until this frame returns' },
  { command: 'stepBack', label: 'Step Back', title: 'One line BACKWARDS' },
  { command: 'reverseContinue', label: 'Reverse', title: 'Backwards to the previous breakpoint' }
]

export function mountDebugView(body: HTMLElement, actions: HTMLElement): void {
  actionsHost = actions

  const start = el('button', 'debug-action', 'Debug')
  start.type = 'button'
  start.id = 'debug-start'
  start.title = 'Start a debug session for the active file'
  start.addEventListener('click', () => void startDebugging())
  startButton = start

  const stop = el('button', 'debug-action debug-action--stop', 'Stop')
  stop.type = 'button'
  stop.id = 'debug-stop'
  stop.addEventListener('click', () => void stopDebugging())
  stopButton = stop

  const controls = el('div', 'debug-controls')
  controls.append(start, stop)

  for (const step of STEPS) {
    const button = el('button', 'debug-action', step.label)
    button.type = 'button'
    button.id = `debug-${step.command}`
    button.title = step.title
    button.addEventListener('click', () => void send(step.command))
    stepButtons.set(step.command, button)
    controls.append(button)
  }

  actions.replaceChildren(controls)

  const status = el('div', 'debug-status')
  status.id = 'debug-status'
  statusEl = status

  const stack = el('div', 'debug-pane__body')
  stack.id = 'debug-stack'
  stackEl = stack

  const locals = el('div', 'debug-pane__body')
  locals.id = 'debug-locals'
  localsEl = locals

  const output = el('pre', 'debug-output')
  output.id = 'debug-output'
  outputEl = output

  const pane = (title: string, content: HTMLElement): HTMLElement => {
    const box = el('div', 'debug-pane')
    box.append(el('div', 'debug-pane__title', title), content)
    return box
  }

  const panes = el('div', 'debug-panes')
  panes.append(pane('Call stack', stack), pane('Locals', locals), pane('Output', output))

  body.replaceChildren(status, panes)
  bodyHost = body

  bindListeners()
  renderAll()
}

export function onDebugShown(): void {
  if (actionsHost !== null) actionsHost.hidden = false
  if (bodyHost !== null) renderAll()
}
