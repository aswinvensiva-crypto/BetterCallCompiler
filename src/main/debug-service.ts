import { promises as fsp } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { Worker } from 'node:worker_threads'
import { BetterCallCompilerServiceError } from '../shared/ipc-contract'
import { isBccPath } from '../shared/lang-diagnostics'
import type { DebugCommandName, DebugExit, DebugStarted, DebugState } from '../shared/types'
import { confinePath, getWorkspace } from './fs-service'
import type { VmWorkerMessage } from './lang-vm-worker'

/**
 * Debug sessions for `.bcc`, one worker each.
 *
 * Separate from `runner.ts` on purpose, even though both end up talking to
 * `lang-vm-worker.js`. A run is fire-and-forget: it streams to completion and
 * the worker is thrown away. A debug session is a CONVERSATION — it outlives
 * many commands, and it deliberately outlives the program ending, because the
 * moment after the last `print` is the most interesting place to step backwards
 * from. Folding the two into `runner.ts` would have meant an `ActiveRun` that
 * is finished but must not be finished, which is the shape of a bug rather than
 * a feature.
 *
 * ## Compile failures never open a session
 *
 * A program that does not compile has nothing to step through. The worker says
 * so with output and an exit, and this forwards it as `debug:exited` with the
 * diagnostics attached — so the panel shows the errors rather than an empty
 * stack it will wait forever to fill.
 */

interface Session {
  readonly worker: Worker
  readonly relativePath: string
  /** Compile diagnostics, accumulated until the worker says whether it started. */
  readonly errors: string[]
}

const sessions = new Map<string, Session>()
let sequence = 0

type StoppedEmitter = (state: DebugState) => void
type ExitEmitter = (exit: DebugExit) => void

let emitStopped: StoppedEmitter = () => {}
let emitExited: ExitEmitter = () => {}

export function setDebugEmitters(stopped: StoppedEmitter, exited: ExitEmitter): void {
  emitStopped = stopped
  emitExited = exited
}

/* ------------------------------------------------------------------ *
 * Starting
 * ------------------------------------------------------------------ */

export async function startDebug(requestedPath: string): Promise<DebugStarted> {
  const workspace = getWorkspace()
  if (workspace.root === null) {
    throw new BetterCallCompilerServiceError('NO_WORKSPACE', 'open a folder before debugging a file')
  }
  const workspaceRoot = workspace.root

  const filePath = await confinePath(workspaceRoot, requestedPath)

  /*
   * The one language this debugger can drive. Everything else would need a real
   * DAP adapter — `dap-client.ts` exists for exactly that and is not wired to a
   * launcher yet, so refusing here is honest. Starting a session that could
   * never stop anywhere would be worse.
   */
  if (!isBccPath(filePath)) {
    throw new BetterCallCompilerServiceError(
      'UNSUPPORTED',
      'the built-in debugger runs .bcc files; other languages need a debug adapter'
    )
  }

  const source = await fsp.readFile(filePath, 'utf8')
  const relativePath = relative(workspaceRoot, filePath).split(sep).join('/')
  const runId = `debug-${++sequence}`

  const worker = new Worker(join(__dirname, 'lang-vm-worker.js'))
  const session: Session = { worker, relativePath, errors: [] }
  sessions.set(runId, session)

  worker.on('message', (message: VmWorkerMessage) => {
    if (message.runId !== runId) return

    if (message.type === 'output') {
      // Only compile diagnostics reach this channel: a running program's
      // `print` output rides on the state snapshot, because it can be undone.
      session.errors.push(message.text)
      return
    }

    if (message.type === 'stopped') {
      /*
       * Copied field by field rather than spread. The worker's message carries
       * a `type` discriminator that the wire schema is `strictObject` about,
       * and its arrays are `readonly` while the schema infers mutable ones —
       * so a spread compiles into a payload main would reject its own emit of.
       */
      emitStopped({
        runId,
        stop: message.stop,
        frames: [...message.frames],
        locals: message.locals.map((scope) => ({
          frameId: scope.frameId,
          variables: [...scope.variables]
        })),
        output: message.output,
        breakpoints: [...message.breakpoints],
        finished: message.finished
      })
      return
    }

    end(runId, message.code, session.errors.join(''))
  })

  worker.on('error', (error: Error) => {
    end(runId, 2, `${error.message}\n`)
  })

  worker.postMessage({ type: 'debug', runId, source, relativePath, breakpoints: [] })

  return { runId, filePath, relativePath }
}

/* ------------------------------------------------------------------ *
 * Driving
 * ------------------------------------------------------------------ */

export function sendCommand(runId: string, command: DebugCommandName): boolean {
  const session = sessions.get(runId)
  if (session === undefined) return false
  session.worker.postMessage({ type: 'command', runId, command })
  return true
}

export function setBreakpoints(runId: string, lines: readonly number[]): boolean {
  const session = sessions.get(runId)
  if (session === undefined) return false
  session.worker.postMessage({ type: 'breakpoints', runId, lines: [...lines] })
  return true
}

/* ------------------------------------------------------------------ *
 * Ending
 * ------------------------------------------------------------------ */

/**
 * Ends a session and tells the renderer. Idempotent.
 *
 * The worker is terminated rather than asked to stop: it owns nothing on disk,
 * and a session wedged inside a very long `continue` must still be closable —
 * the same argument `cancelRun` makes.
 */
function end(runId: string, code: number, message: string): void {
  const session = sessions.get(runId)
  if (session === undefined) return

  sessions.delete(runId)
  void session.worker.terminate()
  emitExited({ runId, code, message })
}

export function stopDebug(runId: string): boolean {
  if (!sessions.has(runId)) return false
  end(runId, 130, '')
  return true
}

/** Every session, on window close. Nothing here survives the window. */
export function stopAllDebugSessions(): void {
  for (const runId of [...sessions.keys()]) end(runId, 130, '')
}

/** For tests and diagnostics: how many sessions are live. */
export function activeDebugSessions(): number {
  return sessions.size
}
