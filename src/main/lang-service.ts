import { Worker } from 'node:worker_threads'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { coalesceBatches } from '../shared/compiler-protocol'
import { isBccPath } from '../shared/lang-diagnostics'
import {
  emptyLangQueryResult,
  isLangMessage,
  type LangMessage,
  type LangQueryKind,
  type LangQueryResult,
  type LangRequest
} from '../shared/lang-protocol'
import {
  unsupportedObservatorySnapshot,
  type CompilerPass,
  type DefinitionResult,
  type DiagnosticsBatch,
  type DocumentOverlay,
  type DocumentSymbolsResult,
  type FileDiagnostics,
  type FsWatchEvent,
  type HoverResult,
  type ObservatorySnapshot,
  type ReferencesResult,
  type RenameResult
} from '../shared/types'
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

/**
 * In-flight navigation queries, keyed by request id.
 *
 * Cloned from `compiler-service.ts`'s `pendingDependents` for the same three
 * reasons it exists: a worker answers out of order, an answer can never arrive,
 * and a restart must settle everything rather than leave a caller waiting
 * forever. That last one is the easiest to forget and the one that leaks —
 * every resolver here has to be settled beside `clearOwner('bcc')`, or a daemon
 * crash during a Find All References hangs the invoke until its timeout and
 * leaks the resolver until the process exits.
 */
let nextRequestId = 1
const pendingQueries = new Map<number, (result: LangQueryResult) => void>()

/** How long an interactive query waits before answering empty. */
const QUERY_TIMEOUT_MS = 5_000

/**
 * In-flight Observatory requests, keyed by request id — the same shape as
 * `pendingQueries` and for the same three reasons: the worker can answer out
 * of order, an answer can never arrive, and a restart must settle everything
 * or a daemon crash mid-Observatory-request hangs the invoke until its
 * timeout.
 */
const pendingObservatory = new Map<number, (snapshot: ObservatorySnapshot) => void>()

/** How long an Observatory request waits before answering "unsupported". */
const OBSERVATORY_TIMEOUT_MS = 5_000

/**
 * Part 12, surfaced: every `CompilerPass` this daemon has posted, bounded the
 * same way `compiler-service.ts` bounds its own — a session left open for
 * hours must not grow this without limit.
 */
const MAX_PASS_HISTORY = 50
let passes: CompilerPass[] = []

let emitDiagnostics: ((batch: DiagnosticsBatch) => void) | null = null
let emitChanged: (() => void) | null = null
let emitPass: ((pass: CompilerPass) => void) | null = null

/**
 * `onChanged` fires after diagnostics are published, so the caller can re-emit
 * a status the store's counts feed. Without it a `.bcc` error would appear in
 * the Problems panel while the status bar kept reporting the old total.
 *
 * `onPass` is optional — most callers of this module (the unit tests included)
 * have no Compiler Intelligence panel to feed and should not have to supply a
 * no-op.
 */
export function setLangEmitters(
  onDiagnostics: (batch: DiagnosticsBatch) => void,
  onChanged: () => void,
  onPass?: (pass: CompilerPass) => void
): void {
  emitDiagnostics = onDiagnostics
  emitChanged = onChanged
  emitPass = onPass ?? null
}

/** Every pass this daemon has posted this session, oldest first. */
export function langPasses(): CompilerPass[] {
  return passes
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
  abandonQueries()
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

    case 'queryResult': {
      const settle = pendingQueries.get(message.requestId)
      pendingQueries.delete(message.requestId)
      settle?.(message.result)
      return
    }

    case 'observatoryResult': {
      const settle = pendingObservatory.get(message.requestId)
      pendingObservatory.delete(message.requestId)
      settle?.(message.snapshot)
      return
    }

    case 'pass':
      passes.push(message.pass)
      if (passes.length > MAX_PASS_HISTORY) passes = passes.slice(-MAX_PASS_HISTORY)
      emitPass?.(message.pass)
      return

    case 'failure':
      failure = message.detail
      return
  }
}

/* ------------------------------- querying --------------------------------- */

/**
 * Asks the daemon one question about one offset.
 *
 * Resolves empty rather than rejecting when the daemon is down or slow, for the
 * reason `dependentsOf` does the same: Monaco logs a rejected provider as a
 * console error and shows the user nothing different, so a rejection buys a
 * red line in the log and costs the ability to tell "no answer" from "broken".
 *
 * The generic is what keeps the narrowing honest. A caller asking for `'hover'`
 * gets a `HoverResult` back, and a worker that answered with the wrong kind —
 * which would be a bug in the worker's switch — is treated as no answer rather
 * than handed to a caller that will read fields it does not have.
 */
type AnswerFor<K extends LangQueryKind> = Omit<Extract<LangQueryResult, { kind: K }>, 'kind'>

/**
 * Drops the discriminant.
 *
 * It exists to correlate the answer with the question ON THE WIRE and has no
 * business past this boundary — `renameResultSchema` and its siblings are
 * `strictObject`, so a stray `kind` would be rejected as a BAD_RESPONSE and the
 * user would see nothing with no clue why. Stripping it here rather than in
 * five `ipc.ts` handlers keeps that from being something four of them remember.
 */
function withoutKind<K extends LangQueryKind>(result: Extract<LangQueryResult, { kind: K }>): AnswerFor<K> {
  const { kind: _discriminant, ...answer } = result
  return answer as AnswerFor<K>
}

function query<K extends LangQueryKind>(
  kind: K,
  relativePath: string,
  offset: number,
  overlay: DocumentOverlay | null,
  newName: string | null = null
): Promise<AnswerFor<K>> {
  const empty = withoutKind(emptyLangQueryResult(kind))
  if (worker === null) return Promise.resolve(empty)

  return new Promise((settle) => {
    const requestId = nextRequestId++

    const timer = setTimeout(() => {
      pendingQueries.delete(requestId)
      settle(empty)
    }, QUERY_TIMEOUT_MS)
    timer.unref?.()

    pendingQueries.set(requestId, (result) => {
      clearTimeout(timer)
      // A worker that answered the wrong question is a bug in its switch, and
      // the caller must not read fields the shape it asked for does not have.
      settle(
        result.kind === kind
          ? withoutKind(result as Extract<LangQueryResult, { kind: K }>)
          : empty
      )
    })

    send({ type: 'query', requestId, kind, relativePath, offset, newName, overlay })
  })
}

/** Settles every in-flight query, so a restart never leaves a caller hanging. */
function abandonQueries(): void {
  const settling = [...pendingQueries.values()]
  pendingQueries.clear()
  // The kind is unrecoverable from the resolver alone, and it does not need to
  // be: `query` above discards a result whose kind does not match what it asked
  // for, so any of them collapses to that caller's own empty answer.
  for (const settle of settling) settle(emptyLangQueryResult('definition'))

  const settlingObservatory = [...pendingObservatory.values()]
  pendingObservatory.clear()
  for (const settle of settlingObservatory) settle(unsupportedObservatorySnapshot('', ''))
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
  abandonQueries()
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

/* ------------------------------- navigation ------------------------------- */

export function langDefinition(
  relativePath: string,
  offset: number,
  overlay: DocumentOverlay | null
): Promise<DefinitionResult> {
  return query('definition', relativePath, offset, overlay)
}

export function langReferences(
  relativePath: string,
  offset: number,
  overlay: DocumentOverlay | null
): Promise<ReferencesResult> {
  return query('references', relativePath, offset, overlay)
}

export function langRename(
  relativePath: string,
  offset: number,
  newName: string | null,
  overlay: DocumentOverlay | null
): Promise<RenameResult> {
  return query('rename', relativePath, offset, overlay, newName)
}

export function langDocumentSymbols(
  relativePath: string,
  overlay: DocumentOverlay | null
): Promise<DocumentSymbolsResult> {
  // Offset zero, and unused: an outline is about the whole file. Sent anyway
  // because one message shape for every query is what keeps the correlation,
  // the timeout and the restart cleanup to one copy each.
  return query('documentSymbols', relativePath, 0, overlay)
}

export function langHover(
  relativePath: string,
  offset: number,
  overlay: DocumentOverlay | null
): Promise<HoverResult> {
  return query('hover', relativePath, offset, overlay)
}

/**
 * Every stage of one `.bcc` file, for the Observatory.
 *
 * A parallel to `query` above rather than a call to it: the answer here is not
 * one of the five `LangQueryResult` shapes, so the discriminant-narrowing
 * `withoutKind` has nothing to strip and `pendingObservatory` is its own map
 * rather than a sixth `LangQueryKind`. Resolves to `unsupported` — never
 * rejects — for the same reason `query` never rejects: a dead daemon or a slow
 * answer must read as "nothing to show yet", not as a console error with
 * nothing pointing at the cause.
 */
export function langObservatory(
  relativePath: string,
  overlay: DocumentOverlay | null
): Promise<ObservatorySnapshot> {
  const empty = unsupportedObservatorySnapshot(relativePath, relativePath)
  if (worker === null) return Promise.resolve(empty)

  return new Promise((settle) => {
    const requestId = nextRequestId++

    const timer = setTimeout(() => {
      pendingObservatory.delete(requestId)
      settle(empty)
    }, OBSERVATORY_TIMEOUT_MS)
    timer.unref?.()

    pendingObservatory.set(requestId, (snapshot) => {
      clearTimeout(timer)
      settle(snapshot)
    })

    send({ type: 'observatory', requestId, relativePath, overlay })
  })
}

/** Test seam: resets every module-level value between cases. */
export function resetLangForTests(): void {
  stopLang()
  workerFactory = null
  workspaceRoot = null
  emitDiagnostics = null
  emitChanged = null
  emitPass = null
  restartTimestamps = []
  missedHeartbeats = 0
  heartbeatNonce = 0
  nextRequestId = 1
  passes = []
}
