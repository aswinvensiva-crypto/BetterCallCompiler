import { Worker } from 'node:worker_threads'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  emptyInteractiveAnswer,
  isInteractiveMessage,
  type InteractiveMessage,
  type InteractiveQueryAnswer,
  type InteractiveQueryKind,
  type InteractiveRequest
} from '../shared/interactive-protocol'
import type {
  CompletionDetailResult,
  CompletionsResult,
  DocumentOverlay,
  FsWatchEvent,
  HoverResult,
  SignatureHelpResult
} from '../shared/types'

/**
 * Supervises the interactive daemon.
 *
 * A third supervisor, and the third copy of a restart budget, a heartbeat and a
 * backoff. Sharing one across three workers would mean one restart budget and
 * one place for a bug in any of them to stop the others, which is the opposite
 * of the reason they are separate threads.
 *
 * ## What is different here
 *
 * It publishes nothing. No diagnostics, no status of its own, no clean sweep —
 * so there is no `clearOwner` to call on a crash and nothing to unwind. A dead
 * interactive daemon simply stops answering, and `isInteractiveReady()` turns
 * false, which is the renderer's cue to fall back to Monaco's own providers.
 * That fallback is why this failing is a degradation rather than an outage, and
 * why the restart budget can be small.
 *
 * It also never receives a cancellation flag. Nothing it does takes long enough
 * to be worth interrupting, and a request here is superseded by the next
 * keystroke rather than cancelled.
 */

const HEARTBEAT_MS = 5_000
const MISSED_HEARTBEATS_BEFORE_KILL = 3

const RESTART_BUDGET = 3
const RESTART_WINDOW_MS = 60_000
const RESTART_BACKOFF_MS = [500, 2_000, 5_000] as const

const WATCH_COALESCE_MS = 50

/**
 * Short, and shorter than the check daemon's five seconds on purpose.
 *
 * A completion the user has already typed past is worse than no completion: it
 * arrives after the list has been dismissed, and the only thing a long timeout
 * buys is holding a resolver open for an answer nobody will see.
 */
const QUERY_TIMEOUT_MS = 2_000

/**
 * The one-off allowance while the program is still being built.
 *
 * A query sent during indexing is not late, it is early: worker messages are
 * FIFO and `boot` went first, so it is answered as soon as the walk finishes.
 * Timing it out at two seconds would turn the first completion after opening a
 * large workspace into an empty list for no reason.
 */
const FIRST_QUERY_TIMEOUT_MS = 20_000

export interface InteractiveWorkerHandle {
  postMessage(message: InteractiveRequest): void
  terminate(): Promise<number> | void
  on(event: 'message', listener: (value: unknown) => void): void
  on(event: 'error', listener: (error: Error) => void): void
  on(event: 'exit', listener: (code: number) => void): void
}

/** Injected so the supervisor can be unit-tested without spawning a thread. */
export type InteractiveWorkerFactory = () => InteractiveWorkerHandle

let workspaceRoot: string | null = null
let worker: InteractiveWorkerHandle | null = null
let workerFactory: InteractiveWorkerFactory | null = null

let ready = false
let indexed = false
let restartTimestamps: number[] = []

/** Open buffers, replayed after a restart so the daemon never loses them. */
const openDocuments = new Map<string, { content: string; version: number }>()

let pendingChanged = new Set<string>()
let pendingRemoved = new Set<string>()
let watchTimer: ReturnType<typeof setTimeout> | null = null

let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let heartbeatNonce = 0
let missedHeartbeats = 0

let nextRequestId = 1
const pendingQueries = new Map<number, (result: InteractiveQueryAnswer) => void>()

let onReadyChanged: (() => void) | null = null

/**
 * Fired when the daemon becomes usable or stops being usable.
 *
 * The renderer switches Monaco's own hover, completion and signature-help
 * providers off when this turns true and would show duplicates if it were told
 * too early, so "ready" means INDEXED — the program is built and the first
 * answer will not also be paying to construct it.
 */
export function setInteractiveReadyListener(listener: (() => void) | null): void {
  onReadyChanged = listener
}

export function isInteractiveReady(): boolean {
  return ready && indexed
}

/**
 * Whether the daemon EXISTS, which is a different question from whether it has
 * finished indexing — and it is the one the renderer needs.
 *
 * Monaco's TypeScript contribution reads its mode configuration exactly once,
 * when the first `.ts` model appears, and never listens for a change. So the
 * decision of who answers hover, completions and signature help has to be made
 * before then and cannot be revisited: a later `setModeConfiguration` is a
 * silent no-op, which is how the first version of this shipped a duplicate
 * hover showing `Point` and `any` stacked in one tooltip.
 *
 * "Spawned" is therefore the right bit. A query arriving before the walk
 * finishes is answered when it finishes rather than dropped — see
 * `FIRST_QUERY_TIMEOUT_MS` — so the only case the renderer must keep Monaco's
 * providers for is a worker that could not be started at all.
 */
export function isInteractiveEnabled(): boolean {
  return worker !== null
}

export function setInteractiveWorkerFactory(factory: InteractiveWorkerFactory | null): void {
  workerFactory = factory
}

/* ------------------------------- spawning -------------------------------- */

function defaultWorkerFactory(): InteractiveWorkerHandle {
  const workerPath = join(__dirname, 'interactive-worker.js')
  if (!existsSync(workerPath)) {
    throw new Error('interactive-worker.js missing from the build')
  }
  return new Worker(workerPath) as unknown as InteractiveWorkerHandle
}

function spawn(): void {
  const factory = workerFactory ?? defaultWorkerFactory

  let handle: InteractiveWorkerHandle
  try {
    handle = factory()
  } catch {
    // Nothing to report and nothing to unwind: the renderer keeps Monaco's
    // providers, which is exactly what it had before this worker existed.
    setReady(false, false)
    return
  }

  worker = handle
  missedHeartbeats = 0

  handle.on('message', (raw: unknown) => {
    if (isInteractiveMessage(raw)) receive(raw)
  })
  handle.on('error', () => scheduleRestart())
  handle.on('exit', () => {
    if (worker !== handle) return
    scheduleRestart()
  })

  startHeartbeat()

  if (workspaceRoot !== null) {
    send({ type: 'boot', workspaceRoot })
    for (const [relativePath, doc] of openDocuments) {
      send({ type: 'openDocument', relativePath, content: doc.content, version: doc.version })
    }
  }
}

function send(message: InteractiveRequest): void {
  try {
    worker?.postMessage(message)
  } catch {
    // The port can close between the check and the post; the exit handler picks
    // it up rather than this throwing into a caller.
  }
}

function setReady(nowReady: boolean, nowIndexed: boolean): void {
  const before = isInteractiveReady()
  ready = nowReady
  indexed = nowIndexed
  if (isInteractiveReady() !== before) onReadyChanged?.()
}

/* ------------------------------- restarting ------------------------------- */

function scheduleRestart(): void {
  stopHeartbeat()
  worker = null
  setReady(false, false)
  abandonQueries()

  const now = Date.now()
  restartTimestamps = restartTimestamps.filter((at) => now - at < RESTART_WINDOW_MS)
  if (restartTimestamps.length >= RESTART_BUDGET) return

  const backoff = RESTART_BACKOFF_MS[restartTimestamps.length] ?? 5_000
  restartTimestamps.push(now)

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
      scheduleRestart()
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

function receive(message: InteractiveMessage): void {
  switch (message.type) {
    case 'ready':
      setReady(true, indexed)
      return

    case 'indexed':
      setReady(ready, true)
      return

    case 'pong':
      missedHeartbeats = 0
      return

    case 'queryResult': {
      const settle = pendingQueries.get(message.requestId)
      pendingQueries.delete(message.requestId)
      settle?.(message.result)
      return
    }

    case 'failure':
      // Reported by the worker rather than by dying, so it is still alive and
      // still worth asking. Nothing to unwind.
      return
  }
}

/* -------------------------------- querying -------------------------------- */

type AnswerFor<K extends InteractiveQueryKind> = Omit<
  Extract<InteractiveQueryAnswer, { kind: K }>,
  'kind'
>

/** Drops the wire discriminant, which every response schema would reject. */
function withoutKind<K extends InteractiveQueryKind>(
  result: Extract<InteractiveQueryAnswer, { kind: K }>
): AnswerFor<K> {
  const { kind: _discriminant, ...answer } = result
  return answer as AnswerFor<K>
}

interface QueryExtras {
  readonly entryName?: string | null
  readonly entrySource?: string | null
}

function query<K extends InteractiveQueryKind>(
  kind: K,
  relativePath: string,
  offset: number,
  overlay: DocumentOverlay | null,
  extras: QueryExtras = {}
): Promise<AnswerFor<K>> {
  const empty = withoutKind(emptyInteractiveAnswer(kind))
  if (worker === null) return Promise.resolve(empty)

  return new Promise((settle) => {
    const requestId = nextRequestId++

    const timer = setTimeout(
      () => {
        pendingQueries.delete(requestId)
        settle(empty)
      },
      isInteractiveReady() ? QUERY_TIMEOUT_MS : FIRST_QUERY_TIMEOUT_MS
    )
    timer.unref?.()

    pendingQueries.set(requestId, (result) => {
      clearTimeout(timer)
      settle(
        result.kind === kind
          ? withoutKind(result as Extract<InteractiveQueryAnswer, { kind: K }>)
          : empty
      )
    })

    send({
      type: 'query',
      requestId,
      kind,
      relativePath,
      offset,
      entryName: extras.entryName ?? null,
      entrySource: extras.entrySource ?? null,
      overlay
    })
  })
}

function abandonQueries(): void {
  const settling = [...pendingQueries.values()]
  pendingQueries.clear()
  for (const settle of settling) settle(emptyInteractiveAnswer('hover'))
}

export function interactiveHover(
  relativePath: string,
  offset: number,
  overlay: DocumentOverlay | null
): Promise<HoverResult> {
  return query('hover', relativePath, offset, overlay)
}

export function interactiveCompletions(
  relativePath: string,
  offset: number,
  overlay: DocumentOverlay | null
): Promise<CompletionsResult> {
  return query('completions', relativePath, offset, overlay)
}

export function interactiveCompletionDetail(
  relativePath: string,
  offset: number,
  entryName: string,
  entrySource: string | null,
  overlay: DocumentOverlay | null
): Promise<CompletionDetailResult> {
  return query('completionDetail', relativePath, offset, overlay, { entryName, entrySource })
}

export function interactiveSignatureHelp(
  relativePath: string,
  offset: number,
  overlay: DocumentOverlay | null
): Promise<SignatureHelpResult> {
  return query('signatureHelp', relativePath, offset, overlay)
}

/* --------------------------------- watch ---------------------------------- */

/**
 * Fanned out from the same `setWatchEmitter` callback the other two daemons
 * use. One chokidar watcher, three consumers.
 */
export function notifyInteractiveWatchEvent(event: FsWatchEvent): void {
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

export function startInteractive(root: string | null): void {
  stopInteractive()
  workspaceRoot = root
  if (root === null) return
  restartTimestamps = []
  spawn()
}

export function stopInteractive(): void {
  stopHeartbeat()
  if (watchTimer !== null) clearTimeout(watchTimer)
  watchTimer = null

  const dying = worker
  worker = null
  if (dying !== null) void dying.terminate()

  abandonQueries()
  openDocuments.clear()
  pendingChanged = new Set()
  pendingRemoved = new Set()
  setReady(false, false)
}

export function restartInteractive(): void {
  const root = workspaceRoot
  stopInteractive()
  startInteractive(root)
}

export function openInteractiveDocument(
  relativePath: string,
  content: string,
  version: number
): void {
  openDocuments.set(relativePath, { content, version })
  send({ type: 'openDocument', relativePath, content, version })
}

export function closeInteractiveDocument(relativePath: string): void {
  openDocuments.delete(relativePath)
  send({ type: 'closeDocument', relativePath })
}

/** Test seam: resets every module-level value between cases. */
export function resetInteractiveForTests(): void {
  stopInteractive()
  workerFactory = null
  workspaceRoot = null
  onReadyChanged = null
  restartTimestamps = []
  missedHeartbeats = 0
  heartbeatNonce = 0
  nextRequestId = 1
}
