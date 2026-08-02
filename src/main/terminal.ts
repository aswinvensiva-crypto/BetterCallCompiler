import { spawn, type IPty } from 'node-pty'
import { BetterCallCompilerServiceError } from '../shared/ipc-contract'
import type { TerminalExit, TerminalSession } from '../shared/types'
import { killProcessTree, resolveShell } from './toolchains'

/**
 * PTY session pool.
 *
 * node-pty 1.1.0 ships Node-API prebuilds, so nothing here needs rebuilding
 * against Electron's ABI — see the notes in the README. The interesting work in
 * this file is flow control, not spawning.
 */
interface Session {
  readonly id: string
  readonly pty: IPty
  readonly shellName: string
  readonly shellPath: string
  /** Bytes waiting to be flushed to the renderer. */
  pending: string
  flushTimer: ReturnType<typeof setTimeout> | null
  disposed: boolean
}

const sessions = new Map<string, Session>()
let sequence = 0

let emitData: ((id: string, data: string) => void) | null = null
let emitExit: ((payload: TerminalExit) => void) | null = null

/**
 * A chatty build can emit thousands of small PTY chunks a second. Forwarding
 * each one as its own IPC message drowns the renderer in structured-clone
 * overhead, so chunks are accumulated and flushed on a short timer. The
 * renderer coalesces again on requestAnimationFrame before writing to xterm.
 */
const FLUSH_INTERVAL_MS = 12

/** Ceiling on buffered output so a runaway process cannot exhaust memory. */
const MAX_PENDING_CHARS = 1_000_000

export function setTerminalEmitters(
  onData: (id: string, data: string) => void,
  onExit: (payload: TerminalExit) => void
): void {
  emitData = onData
  emitExit = onExit
}

function flush(session: Session): void {
  if (session.flushTimer !== null) {
    clearTimeout(session.flushTimer)
    session.flushTimer = null
  }
  if (session.pending === '' || emitData === null) return

  const payload = session.pending
  session.pending = ''
  emitData(session.id, payload)
}

function scheduleFlush(session: Session): void {
  if (session.flushTimer !== null) return
  session.flushTimer = setTimeout(() => flush(session), FLUSH_INTERVAL_MS)
}

export function createSession(options: {
  cols: number
  rows: number
  cwd: string | null
}): TerminalSession {
  const shell = resolveShell()
  const id = `term-${++sequence}`

  let pty: IPty
  try {
    pty = spawn(shell.file, [], {
      name: 'xterm-256color',
      cols: Math.max(1, options.cols),
      rows: Math.max(1, options.rows),
      cwd: options.cwd ?? process.env['USERPROFILE'] ?? process.cwd(),
      env: { ...process.env } as Record<string, string>
      // `useConpty` is deliberately not passed. Setting it to `true` reads like
      // a guarantee but is treated identically to `undefined` — node-pty picks
      // ConPTY purely on Windows build >= 18309 and silently uses winpty below
      // that. Only `useConpty: false` is authoritative, and we want the default.
    })
  } catch (error) {
    throw new BetterCallCompilerServiceError(
      'IO_ERROR',
      `could not start ${shell.name}: ${error instanceof Error ? error.message : 'unknown error'}`
    )
  }

  const session: Session = {
    id,
    pty,
    shellName: shell.name,
    shellPath: shell.file,
    pending: '',
    flushTimer: null,
    disposed: false
  }

  pty.onData((chunk) => {
    if (session.disposed) return
    session.pending += chunk
    if (session.pending.length > MAX_PENDING_CHARS) {
      session.pending = session.pending.slice(-MAX_PENDING_CHARS)
    }
    scheduleFlush(session)
  })

  pty.onExit(({ exitCode, signal }) => {
    // Flush whatever the process printed before dying, or the user loses the
    // last — usually most important — lines.
    flush(session)
    session.disposed = true
    sessions.delete(id)
    emitExit?.({ id, exitCode, signal: signal ?? null })
  })

  sessions.set(id, session)
  return { id, shellName: shell.name, shellPath: shell.file }
}

function requireSession(id: string): Session {
  const session = sessions.get(id)
  if (session === undefined) {
    throw new BetterCallCompilerServiceError('NOT_FOUND', `no terminal session ${id}`)
  }
  return session
}

export function writeToSession(id: string, data: string): void {
  requireSession(id).pty.write(data)
}

export function resizeSession(id: string, cols: number, rows: number): void {
  const session = requireSession(id)
  try {
    session.pty.resize(Math.max(1, cols), Math.max(1, rows))
  } catch {
    // A resize racing process exit is benign.
  }
}

export function disposeSession(id: string): void {
  const session = sessions.get(id)
  if (session === undefined) return

  session.disposed = true
  if (session.flushTimer !== null) clearTimeout(session.flushTimer)
  sessions.delete(id)

  // Reap the tree first: it is fast and it is what actually frees the
  // grandchildren. node-pty does attempt its own descendant reaping, but that
  // path forks `conpty_console_list_agent.js`, which races the synchronous
  // console teardown and dies with an uncaught "AttachConsole failed". In a
  // packaged app that stack trace is invisible, so the leak is silent.
  killProcessTree(session.pty.pid)

  // `IPty.kill()` blocks its caller for ~1.6s. On the Electron main thread that
  // stalls every window and all IPC, so it runs after the current turn of the
  // loop — by which point taskkill has usually already ended the process.
  setImmediate(() => {
    try {
      // No signal argument: node-pty throws "Signals not supported on windows".
      session.pty.kill()
    } catch {
      // Already gone.
    }
  })
}

export function listSessions(): TerminalSession[] {
  return [...sessions.values()].map((session) => ({
    id: session.id,
    shellName: session.shellName,
    shellPath: session.shellPath
  }))
}

/** Every PTY must die with the window, or the app leaves orphaned shells behind. */
export function disposeAllSessions(): void {
  for (const id of [...sessions.keys()]) disposeSession(id)
}
