import { Worker } from 'node:worker_threads'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  coalesceBatches,
  countSeverities,
  isWorkerMessage,
  type WorkerMessage,
  type WorkerRequest
} from '../shared/compiler-protocol'
import type {
  CompilerDaemonState,
  CompilerPass,
  CompilerStatus,
  DependencyQuery,
  DiagnosticsBatch,
  FileDiagnostics,
  FsWatchEvent
} from '../shared/types'
import { stoppedCompilerStatus } from '../shared/types'

/**
 * Supervises the compiler daemon and batches what it produces.
 *
 * Same shape as `terminal.ts` and `runner.ts`: module-scope handle, emitters
 * injected from `index.ts`, disposal from both window close and app quit. It
 * owns the authoritative diagnostics map so a `compiler:diagnostics` pull is
 * answered without a worker round trip — a lazily-mounted Problems panel must
 * not wait for the next push to show anything.
 */

/** Matches `terminal.ts`'s 12ms flush in shape; 50ms because checks are slower. */
const DIAGNOSTICS_FLUSH_MS = 50

/** Watch events are coalesced before reaching the worker, on the same interval. */
const WATCH_COALESCE_MS = 50

const HEARTBEAT_MS = 5_000
const MISSED_HEARTBEATS_BEFORE_KILL = 3

/**
 * A worker mid-check legitimately misses pings — `getSemanticDiagnostics` is
 * synchronous and uninterruptible. 3 x 5s exceeds any single-file check, and
 * `busySince` on the pong distinguishes "working" from "wedged". A mitigation,
 * not a proof: a pathological file can still exceed it.
 */
const BUSY_GRACE_MS = 60_000

/** A respawn loop burns a core forever and the user never finds out. */
const RESTART_BUDGET = 3
const RESTART_WINDOW_MS = 60_000
const RESTART_BACKOFF_MS = [500, 2_000, 5_000] as const

/**
 * V8 enforces this inside the isolate, and the thread dies with
 * ERR_WORKER_OUT_OF_MEMORY on the existing error handler — so OOM reuses the
 * restart path with no extra code. A `process.memoryUsage()` poll cannot run
 * while the worker is blocked in a synchronous check, which is exactly when it
 * would blow up, so the poll is structurally unable to catch its own case.
 */
const MAX_OLD_GENERATION_MB = 1536

export interface WorkerHandle {
  postMessage(message: WorkerRequest): void
  terminate(): Promise<number> | void
  on(event: 'message', listener: (value: unknown) => void): void
  on(event: 'error', listener: (error: Error) => void): void
  on(event: 'exit', listener: (code: number) => void): void
}

/** Injected so the supervisor can be unit-tested without spawning a thread. */
export type WorkerFactory = () => WorkerHandle

let workspaceRoot: string | null = null
let worker: WorkerHandle | null = null
let workerFactory: WorkerFactory | null = null

let state: CompilerDaemonState = 'stopped'
let detail: string | null = null
let restarts = 0
let restartTimestamps: number[] = []
let heapUsedMb = 0

let graphSummary = stoppedCompilerStatus().graph
let checkedFileCount = 0

/** Authoritative per-file diagnostics; answers pulls without a round trip. */
const diagnosticsByPath = new Map<string, FileDiagnostics>()

/** Open buffers, replayed after a restart so the daemon never loses them. */
const openDocuments = new Map<string, { content: string; version: number }>()

/**
 * Recent check passes, newest last.
 *
 * Bounded rather than unbounded: this is observability for a long-running
 * process, and each pass carries up to 500 trace events. An unbounded history
 * is a memory leak that only shows up after an hour of typing — the exact
 * failure a daemon must not have.
 */
const MAX_PASS_HISTORY = 50
let passes: CompilerPass[] = []

let pendingDiagnostics: FileDiagnostics[] = []
let pendingSettled = false
let flushTimer: ReturnType<typeof setTimeout> | null = null

let pendingChanged = new Set<string>()
let pendingRemoved = new Set<string>()
let watchTimer: ReturnType<typeof setTimeout> | null = null

let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let heartbeatNonce = 0
let missedHeartbeats = 0
let workerBusySince: number | null = null

let nextRequestId = 1
const pendingDependents = new Map<number, (query: DependencyQuery) => void>()

let emitDiagnostics: ((batch: DiagnosticsBatch) => void) | null = null
let emitStatus: ((status: CompilerStatus) => void) | null = null
let emitPass: ((pass: CompilerPass) => void) | null = null

export function setCompilerEmitters(
  onDiagnostics: (batch: DiagnosticsBatch) => void,
  onStatus: (status: CompilerStatus) => void,
  onPass?: (pass: CompilerPass) => void
): void {
  emitDiagnostics = onDiagnostics
  emitStatus = onStatus
  emitPass = onPass ?? null
}

/** Overridden by tests; production spawns the real worker file. */
export function setWorkerFactory(factory: WorkerFactory | null): void {
  workerFactory = factory
}

export function compilerStatus(): CompilerStatus {
  const { errorCount, warningCount } = countSeverities([...diagnosticsByPath.values()])
  return {
    state,
    graph: graphSummary,
    errorCount,
    warningCount,
    checkedFileCount,
    heapUsedMb,
    restarts,
    detail
  }
}

function setState(next: CompilerDaemonState, nextDetail: string | null = null): void {
  state = next
  detail = nextDetail
  emitStatus?.(compilerStatus())
}

/* ------------------------------- spawning -------------------------------- */

function defaultWorkerFactory(): WorkerHandle {
  // No app.isPackaged branch: electron-vite builds main to out/main/ in dev
  // too, so __dirname is out/main in dev, under the E2E harness, and inside
  // app.asar when packaged. Same reasoning as `rendererRoot` in index.ts.
  const workerPath = join(__dirname, 'compiler-worker.js')

  if (!existsSync(workerPath)) {
    // A silently absent worker is the failure mode that costs a day.
    throw new Error('compiler-worker.js missing from the build')
  }

  return new Worker(workerPath, {
    resourceLimits: { maxOldGenerationSizeMb: MAX_OLD_GENERATION_MB }
  }) as unknown as WorkerHandle
}

function spawn(): void {
  const factory = workerFactory ?? defaultWorkerFactory

  let handle: WorkerHandle
  try {
    handle = factory()
  } catch (error) {
    setState('failed', error instanceof Error ? error.message : 'could not start the daemon')
    return
  }

  worker = handle
  missedHeartbeats = 0
  workerBusySince = null

  handle.on('message', (raw: unknown) => {
    if (isWorkerMessage(raw)) receive(raw)
  })
  handle.on('error', (error: Error) => scheduleRestart(error.message))
  handle.on('exit', (code: number) => {
    if (worker !== handle) return // already replaced
    scheduleRestart(`worker exited with code ${code}`)
  })

  startHeartbeat()

  if (workspaceRoot !== null) {
    send({ type: 'boot', workspaceRoot })
    // Replay open buffers so a restarted daemon sees what the user is looking
    // at, not the last thing written to disk.
    for (const [relativePath, doc] of openDocuments) {
      send({ type: 'openDocument', relativePath, content: doc.content, version: doc.version })
    }
  }
}

function send(message: WorkerRequest): void {
  try {
    worker?.postMessage(message)
  } catch {
    // The port can close between the check and the post; the exit handler will
    // pick it up rather than this throwing into a caller.
  }
}

/* ------------------------------- restarting ------------------------------- */

function scheduleRestart(reason: string): void {
  stopHeartbeat()
  worker = null

  // Diagnostics from a dead worker are not trustworthy, and leaving them would
  // strand markers for state nobody is maintaining any more.
  diagnosticsByPath.clear()
  flushNow(true)

  const now = Date.now()
  restartTimestamps = restartTimestamps.filter((at) => now - at < RESTART_WINDOW_MS)

  if (restartTimestamps.length >= RESTART_BUDGET) {
    setState('failed', `${reason} — gave up after ${RESTART_BUDGET} restarts in a minute`)
    return
  }

  const backoff = RESTART_BACKOFF_MS[restartTimestamps.length] ?? 5_000
  restartTimestamps.push(now)
  restarts++
  setState('restarting', reason)

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
      // A long synchronous check is not a hang. `busySince` is what tells them
      // apart; without it a healthy worker gets killed mid-check.
      const busyFor = workerBusySince === null ? 0 : Date.now() - workerBusySince
      if (busyFor > 0 && busyFor < BUSY_GRACE_MS) return

      const dying = worker
      worker = null
      void dying.terminate()
      scheduleRestart('worker stopped answering heartbeats')
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

function receive(message: WorkerMessage): void {
  switch (message.type) {
    case 'ready':
      setState('starting')
      return

    case 'pong':
      missedHeartbeats = 0
      heapUsedMb = message.heapUsedMb
      workerBusySince = message.busySince
      return

    case 'state':
      graphSummary = message.graph
      checkedFileCount = message.checkedFileCount
      setState(message.state)
      return

    case 'diagnostics':
      for (const file of message.files) {
        // The map is authoritative, so it is updated immediately even though
        // the emit is debounced — a pull between batches must be accurate.
        diagnosticsByPath.set(file.relativePath, file)
        pendingDiagnostics.push(file)
      }
      pendingSettled = pendingSettled || message.settled
      scheduleFlush()
      return

    case 'pass':
      passes.push(message.pass)
      if (passes.length > MAX_PASS_HISTORY) passes = passes.slice(-MAX_PASS_HISTORY)
      // Emitted immediately rather than batched with diagnostics. The panel is
      // showing how fast the daemon is; delaying the evidence through the same
      // 50ms debounce would make it report its own latency wrong.
      emitPass?.(message.pass)
      return

    case 'dependentsResult': {
      const resolve = pendingDependents.get(message.requestId)
      pendingDependents.delete(message.requestId)
      resolve?.(message.query)
      return
    }

    case 'failure':
      setState('failed', message.detail)
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
  const settled = pendingSettled
  pendingDiagnostics = []
  pendingSettled = false

  if (files.length > 0 || force) {
    emitDiagnostics?.({ files, settled })
    emitStatus?.(compilerStatus())
  }
}

/* --------------------------------- watch ---------------------------------- */

/**
 * Fanned out from the existing `setWatchEmitter` callback in index.ts — the
 * chokidar watcher in fs-service.ts is reused rather than a second one started.
 */
export function notifyWatchEvent(event: FsWatchEvent): void {
  if (event.type === 'addDir' || event.type === 'unlinkDir') return

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

export function startCompiler(root: string | null): void {
  stopCompiler()
  workspaceRoot = root
  if (root === null) {
    setState('stopped')
    return
  }
  restarts = 0
  restartTimestamps = []
  setState('starting')
  spawn()
}

export function stopCompiler(): void {
  stopHeartbeat()
  if (watchTimer !== null) clearTimeout(watchTimer)
  if (flushTimer !== null) clearTimeout(flushTimer)
  watchTimer = null
  flushTimer = null

  const dying = worker
  worker = null
  if (dying !== null) void dying.terminate()

  diagnosticsByPath.clear()
  openDocuments.clear()
  // A restarted daemon re-derives everything from cold, so its timings are not
  // comparable with the previous one's. Keeping the old passes would put a warm
  // p95 next to a cold one in the same chart and make the number meaningless.
  passes = []
  pendingDiagnostics = []
  pendingChanged = new Set()
  pendingRemoved = new Set()
  pendingDependents.clear()
  graphSummary = stoppedCompilerStatus().graph
  checkedFileCount = 0
  heapUsedMb = 0
  state = 'stopped'
  detail = null
}

export function restartCompiler(): void {
  const root = workspaceRoot
  stopCompiler()
  startCompiler(root)
}

/**
 * Recent passes, newest last.
 *
 * A pull rather than only an event stream, for the same reason
 * `diagnosticsByPath` is authoritative: the Compiler Intelligence view is
 * lazily mounted, and a panel opened between passes must be able to show
 * history instead of an empty chart until the user happens to type.
 */
export function compilerPasses(): CompilerPass[] {
  return [...passes]
}

export function diagnosticsFor(relativePath: string | null): FileDiagnostics[] {
  if (relativePath === null) return [...diagnosticsByPath.values()]
  const entry = diagnosticsByPath.get(relativePath)
  return entry === undefined ? [] : [entry]
}

export function openDocument(relativePath: string, content: string, version: number): void {
  openDocuments.set(relativePath, { content, version })
  send({ type: 'openDocument', relativePath, content, version })
}

export function closeDocument(relativePath: string): void {
  openDocuments.delete(relativePath)
  send({ type: 'closeDocument', relativePath })
}

/** Resolves with an empty query if the daemon never answers. */
export function dependentsOf(
  relativePath: string,
  from: readonly string[] = [],
  timeoutMs = 5_000
): Promise<DependencyQuery> {
  const empty: DependencyQuery = { node: null, dependents: [], chain: [], cycle: null }
  if (worker === null) return Promise.resolve(empty)

  return new Promise<DependencyQuery>((resolve) => {
    const requestId = nextRequestId++
    const timer = setTimeout(() => {
      pendingDependents.delete(requestId)
      resolve(empty)
    }, timeoutMs)
    timer.unref?.()

    pendingDependents.set(requestId, (query) => {
      clearTimeout(timer)
      resolve(query)
    })
    send({ type: 'dependents', requestId, relativePath, from })
  })
}

/** Test seam: resets every module-level value between cases. */
export function resetCompilerForTests(): void {
  stopCompiler()
  workerFactory = null
  workspaceRoot = null
  emitDiagnostics = null
  emitStatus = null
  emitPass = null
  passes = []
  restarts = 0
  restartTimestamps = []
  missedHeartbeats = 0
  heartbeatNonce = 0
  workerBusySince = null
  nextRequestId = 1
}
