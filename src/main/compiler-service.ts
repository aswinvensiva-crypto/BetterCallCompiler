import { Worker } from 'node:worker_threads'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  coalesceBatches,
  emptyLanguageQueryAnswer,
  isWorkerMessage,
  type LanguageQueryAnswer,
  type LanguageQueryKind,
  type WorkerMessage,
  type WorkerRequest
} from '../shared/compiler-protocol'
import {
  clearOwner,
  diagnosticCounts,
  diagnosticsForPath,
  publishDiagnostics,
  resetDiagnosticStore
} from './diagnostic-store'
import type {
  CompilerDaemonState,
  CompilerPass,
  CodeActionsResult,
  CompilerStatus,
  DefinitionResult,
  DependencyQuery,
  DiagnosticsBatch,
  DocumentOverlay,
  FileDiagnostics,
  FsWatchEvent,
  ReferencesResult,
  RenameResult
} from '../shared/types'
import { stoppedCompilerStatus } from '../shared/types'

/**
 * Supervises the compiler daemon and batches what it produces.
 *
 * Same shape as `terminal.ts` and `runner.ts`: module-scope handle, emitters
 * injected from `index.ts`, disposal from both window close and app quit. It
 * publishes into the authoritative diagnostics store so a
 * `compiler:diagnostics` pull is answered without a worker round trip — a
 * lazily-mounted Problems panel must not wait for the next push to show
 * anything.
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

/*
 * Per-file diagnostics live in `diagnostic-store.ts` rather than here, because
 * BCC's daemon publishes into the same map and the renderer must not need to
 * know there are two producers. Entries remember their owner, so the clear on
 * restart below drops only this daemon's — a TypeScript crash leaves BCC's
 * squiggles alone, which is the "separate failure domains" claim made real.
 */

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

/**
 * In-flight navigation queries, keyed by request id.
 *
 * Shares `nextRequestId` with `pendingDependents` on purpose: two counters
 * could collide, and one monotonic id across every correlated request makes an
 * answer unambiguous whichever map it belongs to.
 *
 * Every resolver here must be settled beside `pendingDependents.clear()` on
 * restart, or a daemon crash during a Find All References hangs the invoke
 * until its timeout and leaks the resolver until the process exits.
 */
const pendingLanguageQueries = new Map<number, (result: LanguageQueryAnswer) => void>()

/** How long an interactive query waits before answering empty. */
const LANGUAGE_QUERY_TIMEOUT_MS = 5_000

/**
 * The one slot that stops a running check.
 *
 * Created once per process and handed to every worker this supervisor spawns,
 * so a restart does not need a new one and nothing has to be re-plumbed. A
 * `SharedArrayBuffer` rather than a message because a message cannot arrive
 * while the worker is inside `getSemanticDiagnostics` — that call is
 * synchronous, and `port.on('message')` dispatches synchronously, so the
 * worker's event loop is not running. Shared memory the checker polls is the
 * only channel that reaches it, which is exactly why tsserver uses a
 * cancellation file for the same job.
 *
 * Guarded because `SharedArrayBuffer` can be absent under a hardened runtime;
 * without it checks simply run to completion, which is what happened before.
 */
const cancellationBuffer =
  typeof SharedArrayBuffer === 'function' ? new SharedArrayBuffer(4) : null
const cancellationFlag = cancellationBuffer === null ? null : new Int32Array(cancellationBuffer)

/** Asks the worker to stop the check it is running and get to this query. */
function requestCancellation(): void {
  if (cancellationFlag !== null) Atomics.store(cancellationFlag, 0, 1)
}

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
  // Totals across BOTH compilers: the status bar counts problems, not producers.
  const { errorCount, warningCount } = diagnosticCounts()
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
    // Stood down before the new worker sees it. A flag raised for a query the
    // dead worker never answered would otherwise cancel the fresh daemon's
    // first check, on a workspace with no diagnostics yet — the one pass it
    // most needs to finish.
    if (cancellationFlag !== null) Atomics.store(cancellationFlag, 0, 0)
    send({ type: 'boot', workspaceRoot, ...(cancellationBuffer === null ? {} : { cancellation: cancellationBuffer }) })
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
  clearOwner('typescript')
  abandonPendingRequests()
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
      // The store is authoritative, so it is updated immediately even though
      // the emit is debounced — a pull between batches must be accurate.
      publishDiagnostics('typescript', message.files)
      for (const file of message.files) pendingDiagnostics.push(file)
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

    case 'languageQueryResult': {
      const settle = pendingLanguageQueries.get(message.requestId)
      pendingLanguageQueries.delete(message.requestId)
      settle?.(message.result)
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

  clearOwner('typescript')
  openDocuments.clear()
  // A restarted daemon re-derives everything from cold, so its timings are not
  // comparable with the previous one's. Keeping the old passes would put a warm
  // p95 next to a cold one in the same chart and make the number meaningless.
  passes = []
  pendingDiagnostics = []
  pendingChanged = new Set()
  pendingRemoved = new Set()
  abandonPendingRequests()
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

/**
 * Answers a pull without a worker round trip.
 *
 * Reads the shared store, so a `.bcc` file's diagnostics come back through the
 * same call the renderer already makes. Named for the compiler daemon for
 * historical reasons; it is really "diagnostics for this path, whoever
 * produced them".
 */
export function diagnosticsFor(relativePath: string | null): FileDiagnostics[] {
  return diagnosticsForPath(relativePath)
}

export function openDocument(relativePath: string, content: string, version: number): void {
  openDocuments.set(relativePath, { content, version })
  send({ type: 'openDocument', relativePath, content, version })
}

export function closeDocument(relativePath: string): void {
  openDocuments.delete(relativePath)
  send({ type: 'closeDocument', relativePath })
}

/* ------------------------------- navigation ------------------------------- */

type AnswerFor<K extends LanguageQueryKind> = Omit<
  Extract<LanguageQueryAnswer, { kind: K }>,
  'kind'
>

/**
 * Drops the discriminant.
 *
 * It exists to correlate the answer with the question ON THE WIRE and has no
 * business past this boundary — `definitionResultSchema` and its sibling are
 * `strictObject`, so a stray `kind` comes back as a BAD_RESPONSE and the user
 * sees nothing with no clue why.
 */
function withoutKind<K extends LanguageQueryKind>(
  result: Extract<LanguageQueryAnswer, { kind: K }>
): AnswerFor<K> {
  const { kind: _discriminant, ...answer } = result
  return answer as AnswerFor<K>
}

/**
 * Asks the daemon one question about one offset.
 *
 * Resolves empty rather than rejecting when the daemon is down or slow, for the
 * reason `dependentsOf` does the same: Monaco logs a rejected provider as a
 * console error and shows the user nothing different.
 *
 * These answers QUEUE BEHIND A CHECK. `port.on('message')` calls the worker's
 * handler synchronously, so nothing is delivered while `getSemanticDiagnostics`
 * is running and no priority queue inside the worker could reorder them. That
 * is the cost being accepted here and the thing A4's cancellation flag removes;
 * the query harness measures the number rather than assuming it is small.
 */
interface QueryExtras {
  readonly newName?: string | null
  readonly endOffset?: number
  readonly diagnosticCodes?: readonly number[]
}

function languageQuery<K extends LanguageQueryKind>(
  kind: K,
  relativePath: string,
  offset: number,
  overlay: DocumentOverlay | null,
  extras: QueryExtras = {}
): Promise<AnswerFor<K>> {
  const empty = withoutKind(emptyLanguageQueryAnswer(kind))
  if (worker === null) return Promise.resolve(empty)

  return new Promise((settle) => {
    const requestId = nextRequestId++

    const timer = setTimeout(() => {
      pendingLanguageQueries.delete(requestId)
      settle(empty)
    }, LANGUAGE_QUERY_TIMEOUT_MS)
    timer.unref?.()

    pendingLanguageQueries.set(requestId, (result) => {
      clearTimeout(timer)
      // A worker that answered the wrong question is a bug in its switch, and
      // the caller must not read fields the shape it asked for does not have.
      settle(
        result.kind === kind
          ? withoutKind(result as Extract<LanguageQueryAnswer, { kind: K }>)
          : empty
      )
    })

    // Raised before the send, so a check already running sees it at its next
    // checkpoint rather than after this message has been sitting in a queue
    // nothing is draining. The worker stands it down the moment it starts
    // answering.
    requestCancellation()
    send({
      type: 'languageQuery',
      requestId,
      kind,
      relativePath,
      offset,
      overlay,
      newName: extras.newName ?? null,
      // Defaults that mean "the caret, and nothing under it": a definition or a
      // reference query carries neither, and a worker reading them for those
      // kinds would be reading fields that were never about it.
      endOffset: extras.endOffset ?? offset,
      diagnosticCodes: extras.diagnosticCodes ?? []
    })
  })
}

/**
 * Settles every correlated request, so a dead worker never leaves one hanging.
 *
 * Called from BOTH `stopCompiler` and `scheduleRestart`. Only the first had it
 * before, which meant a crash — the case that actually happens — left every
 * in-flight `dependentsOf` resolving five seconds later on its timeout, and
 * would have done the same to every navigation query. The Why button opening
 * blank after a daemon crash was that, and nothing said so.
 *
 * The language kind is unrecoverable from the resolver alone, and does not need
 * to be: `languageQuery` discards a result whose kind does not match what it
 * asked for, so any of them collapses to that caller's own empty answer.
 */
function abandonPendingRequests(): void {
  const dependents = [...pendingDependents.values()]
  pendingDependents.clear()
  for (const resolve of dependents) {
    resolve({ node: null, dependents: [], chain: [], cycle: null })
  }

  const queries = [...pendingLanguageQueries.values()]
  pendingLanguageQueries.clear()
  for (const settle of queries) settle(emptyLanguageQueryAnswer('definition'))
}

export function definitionAt(
  relativePath: string,
  offset: number,
  overlay: DocumentOverlay | null
): Promise<DefinitionResult> {
  return languageQuery('definition', relativePath, offset, overlay)
}

export function referencesAt(
  relativePath: string,
  offset: number,
  overlay: DocumentOverlay | null
): Promise<ReferencesResult> {
  return languageQuery('references', relativePath, offset, overlay)
}

export function renameAt(
  relativePath: string,
  offset: number,
  newName: string | null,
  overlay: DocumentOverlay | null
): Promise<RenameResult> {
  return languageQuery('rename', relativePath, offset, overlay, { newName })
}

export function codeActionsAt(
  relativePath: string,
  offset: number,
  endOffset: number,
  diagnosticCodes: readonly number[],
  overlay: DocumentOverlay | null
): Promise<CodeActionsResult> {
  return languageQuery('codeActions', relativePath, offset, overlay, {
    endOffset,
    diagnosticCodes
  })
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
  // The whole store, not just this owner: a test that published as 'bcc' must
  // not leak counts into the next one's `compilerStatus()`.
  resetDiagnosticStore()
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
