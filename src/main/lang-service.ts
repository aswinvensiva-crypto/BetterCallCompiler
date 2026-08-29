import { Worker } from 'node:worker_threads'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { coalesceBatches } from '../shared/compiler-protocol'
import { isBccPath } from '../shared/lang-diagnostics'
import {
  isLangMessage,
  type LangMessage,
  type LangRequest
} from '../shared/lang-protocol'
import type { DiagnosticsBatch, FileDiagnostics, FsWatchEvent } from '../shared/types'
import { clearOwner, publishDiagnostics } from './diagnostic-store'

/**
 * Supervises the BCC daemon.
 *
 * Deliberately a sibling of `compiler-service.ts` rather than a generalisation
 * of it. Sharing one supervisor would mean one restart budget, one heartbeat
 * and one place for a bug in either compiler to stop the other — which is the
 * opposite of the reason the workers are separate threads. The duplicated parts
 * are the restart budget, the backoff and the flush timer, and each is a dozen
 * lines whose behaviour is worth reading in place.
 *
 * What is NOT duplicated is the part that matters: both publish into
 * `diagnostic-store.ts`, so the renderer receives one diagnostics stream and
 * needs no idea that a second compiler exists.
 *
 * ## What is smaller here, and why
 *
 * No `busySince` grace on the heartbeat. That exists in the TypeScript
 * supervisor because a healthy worker legitimately misses pings while blocked
 * in an uninterruptible `getSemanticDiagnostics`. Lexing and parsing one BCC
 * file is microseconds, so a missed heartbeat here is never legitimate — it
 * means a loop that does not terminate, which is precisely what a heartbeat
 * should kill. `MAX_DEPTH` in the parser bounds the recursion I know about;
 * this bounds the one I do not.
 *
 * No memory ceiling either. `resourceLimits` on the TypeScript worker exists
 * because a `ts.Program` over a large repository legitimately reaches a
 * gigabyte. A BCC workspace is a handful of small files, so a worker growing
 * without bound would be a leak rather than a workload, and capping it would
 * only convert a diagnosable leak into a mysterious restart.
 */

const DIAGNOSTICS_FLUSH_MS = 50
const WATCH_COALESCE_MS = 50

const HEARTBEAT_MS = 5_000
const MISSED_HEARTBEATS_BEFORE_KILL = 3

const RESTART_BUDGET = 3
const RESTART_WINDOW_MS = 60_000
const RESTART_BACKOFF_MS = [500, 2_000, 5_000] as const

export interface LangWorkerHandle {
  postMessage(message: LangRequest): void
  terminate(): Promise<number> | void
  on(event: 'message', listener: (value: unknown) => void): void
  on(event: 'error', listener: (error: Error) => void): void
  on(event: 'exit', listener: (code: number) => void): void
}

/** Injected so the supervisor can be unit-tested without spawning a thread. */
export type LangWorkerFactory = () => LangWorkerHandle

let workspaceRoot: string | null = null
let worker: LangWorkerHandle | null = null
let workerFactory: LangWorkerFactory | null = null

let running = false
let failure: string | null = null
let restartTimestamps: number[] = []
let indexedFileCount = 0

/** Open buffers, replayed after a restart so the daemon never loses them. */
const openDocuments = new Map<string, { content: string; version: number }>()

let pendingDiagnostics: FileDiagnostics[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null

let pendingChanged = new Set<string>()
let pendingRemoved = new Set<string>()
let watchTimer: ReturnType<typeof setTimeout> | null = null

let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let heartbeatNonce = 0
let missedHeartbeats = 0

let emitDiagnostics: ((batch: DiagnosticsBatch) => void) | null = null
let emitChanged: (() => void) | null = null

/**
 * `onChanged` fires after diagnostics are published, so the caller can re-emit
 * a status the store's counts feed. Without it a `.bcc` error would appear in
 * the Problems panel while the status bar kept reporting the old total.
 */
export function setLangEmitters(
  onDiagnostics: (batch: DiagnosticsBatch) => void,
  onChanged: () => void
): void {
  emitDiagnostics = onDiagnostics
  emitChanged = onChanged
}

export function setLangWorkerFactory(factory: LangWorkerFactory | null): void {
  workerFactory = factory
}

export interface LangStatus {
  readonly running: boolean
  readonly fileCount: number
  readonly detail: string | null
}

export function langStatus(): LangStatus {
  return { running, fileCount: indexedFileCount, detail: failure }
}

/* ------------------------------- spawning -------------------------------- */

function defaultWorkerFactory(): LangWorkerHandle {
  // Same reasoning as compiler-service: electron-vite emits main entries to
  // out/main/ in dev, under the E2E harness and inside app.asar alike, so
  // __dirname resolves without a packaged-vs-dev branch.
  const workerPath = join(__dirname, 'lang-worker.js')

  if (!existsSync(workerPath)) {
    throw new Error('lang-worker.js missing from the build')
  }

  return new Worker(workerPath) as unknown as LangWorkerHandle
}

function spawn(): void {
  const factory = workerFactory ?? defaultWorkerFactory

  let handle: LangWorkerHandle
  try {
    handle = factory()
  } catch (error) {
    failure = error instanceof Error ? error.message : 'could not start the BCC daemon'
    running = false
    return
  }

  worker = handle
  missedHeartbeats = 0

  handle.on('message', (raw: unknown) => {
    if (isLangMessage(raw)) receive(raw)
  })
  handle.on('error', (error: Error) => scheduleRestart(error.message))
  handle.on('exit', (code: number) => {
    if (worker !== handle) return
    scheduleRestart(`BCC worker exited with code ${code}`)
  })

  startHeartbeat()

  if (workspaceRoot !== null) {
    send({ type: 'boot', workspaceRoot })
    for (const [relativePath, doc] of openDocuments) {
      send({ type: 'openDocument', relativePath, content: doc.content, version: doc.version })
    }
  }
}

function send(message: LangRequest): void {
  try {
    worker?.postMessage(message)
  } catch {
    // The port can close between the check and the post; the exit handler picks
    // it up rather than this throwing into a caller.
  }
}

/* ------------------------------- restarting ------------------------------- */

function scheduleRestart(reason: string): void {
  stopHeartbeat()
  worker = null

  // Only this owner's entries. A BCC crash must not clear TypeScript's
  // squiggles — that is the whole point of the two workers being separate, and
  // a shared clear here would quietly undo it.
  clearOwner('bcc')
  flushNow(true)

  const now = Date.now()
  restartTimestamps = restartTimestamps.filter((at) => now - at < RESTART_WINDOW_MS)

  if (restartTimestamps.length >= RESTART_BUDGET) {
    running = false
    failure = `${reason} — gave up after ${RESTART_BUDGET} restarts in a minute`
    return
  }

  const backoff = RESTART_BACKOFF_MS[restartTimestamps.length] ?? 5_000
  restartTimestamps.push(now)
  failure = reason

  setTimeout(() => {
    if (workspaceRoot === null) return
    spawn()
  }, backoff).unref?.()
}

/* ------------------------------- heartbeat -------------------------------- */

function startHeartbeat(): void {
  stopHeartbeat()
  heartbeatTimer = setInterval(() => {
    if (worker === null) return

    if (missedHeartbeats >= MISSED_HEARTBEATS_BEFORE_KILL) {
      const dying = worker
      worker = null
      void dying.terminate()
      scheduleRestart('BCC worker stopped answering heartbeats')
      return
    }

    missedHeartbeats++
    send({ type: 'ping', nonce: ++heartbeatNonce })
  }, HEARTBEAT_MS)

  heartbeatTimer.unref?.()
}

function stopHeartbeat(): void {
  if (heartbeatTimer !== null) clearInterval(heartbeatTimer)
  heartbeatTimer = null
}

/* -------------------------------- receiving ------------------------------- */

function receive(message: LangMessage): void {
  switch (message.type) {
    case 'ready':
      running = true
      failure = null
      return

    case 'pong':
      missedHeartbeats = 0
      return

    case 'indexed':
      indexedFileCount = message.fileCount
      return

    case 'diagnostics':
      publishDiagnostics('bcc', message.files)
      for (const file of message.files) pendingDiagnostics.push(file)
      scheduleFlush()
      return

    case 'failure':
      failure = message.detail
      return
  }
}

/* -------------------------------- batching -------------------------------- */

function scheduleFlush(): void {
  if (flushTimer !== null) return
  flushTimer = setTimeout(() => flushNow(false), DIAGNOSTICS_FLUSH_MS)
  flushTimer.unref?.()
}

function flushNow(force: boolean): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (pendingDiagnostics.length === 0 && !force) return

  const files = coalesceBatches(pendingDiagnostics)
  pendingDiagnostics = []

  if (files.length > 0 || force) {
    // `settled` is always true: a BCC check names every file it will report on
    // before it starts, and there is no deferral to be honest about. It becomes
    // meaningful only if Part 12 introduces one.
    emitDiagnostics?.({ files, settled: true })
    emitChanged?.()
  }
}

/* --------------------------------- watch ---------------------------------- */

/**
 * Fanned out from the same `setWatchEmitter` callback the TypeScript daemon
 * uses. One chokidar watcher, three consumers.
 *
 * Filtered to `.bcc` HERE rather than in the worker, so a TypeScript-only
 * workspace never wakes this thread at all.
 */
export function notifyLangWatchEvent(event: FsWatchEvent): void {
  if (event.type === 'addDir' || event.type === 'unlinkDir') return
  if (!isBccPath(event.relativePath)) return

  if (event.type === 'unlink') {
    pendingRemoved.add(event.relativePath)
    pendingChanged.delete(event.relativePath)
  } else {
    pendingChanged.add(event.relativePath)
    pendingRemoved.delete(event.relativePath)
  }

  if (watchTimer !== null) return
  watchTimer = setTimeout(() => {
    watchTimer = null
    const changed = [...pendingChanged]
    const removed = [...pendingRemoved]
    pendingChanged = new Set()
    pendingRemoved = new Set()
    if (changed.length === 0 && removed.length === 0) return
    send({ type: 'filesChanged', changed, removed })
  }, WATCH_COALESCE_MS)
  watchTimer.unref?.()
}

/* ------------------------------- public API ------------------------------- */

export function startLang(root: string | null): void {
  stopLang()
  workspaceRoot = root
  if (root === null) return
  restartTimestamps = []
  spawn()
}

export function stopLang(): void {
  stopHeartbeat()
  if (watchTimer !== null) clearTimeout(watchTimer)
  if (flushTimer !== null) clearTimeout(flushTimer)
  watchTimer = null
  flushTimer = null

  const dying = worker
  worker = null
  if (dying !== null) void dying.terminate()

  clearOwner('bcc')
  openDocuments.clear()
  pendingDiagnostics = []
  pendingChanged = new Set()
  pendingRemoved = new Set()
  running = false
  failure = null
  indexedFileCount = 0
}

export function restartLang(): void {
  const root = workspaceRoot
  stopLang()
  startLang(root)
}

export function openLangDocument(
  relativePath: string,
  content: string,
  version: number
): void {
  openDocuments.set(relativePath, { content, version })
  send({ type: 'openDocument', relativePath, content, version })
}

export function closeLangDocument(relativePath: string): void {
  openDocuments.delete(relativePath)
  send({ type: 'closeDocument', relativePath })
}

/** Test seam: resets every module-level value between cases. */
export function resetLangForTests(): void {
  stopLang()
  workerFactory = null
  workspaceRoot = null
  emitDiagnostics = null
  emitChanged = null
  restartTimestamps = []
  missedHeartbeats = 0
  heartbeatNonce = 0
}
