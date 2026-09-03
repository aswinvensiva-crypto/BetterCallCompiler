import type {
  BuildGraphSummary,
  CompilerDaemonState,
  CompilerPass,
  DefinitionResult,
  DependencyQuery,
  DocumentOverlay,
  FileDiagnostics,
  ReferencesResult
} from './types'

/**
 * The worker ↔ main message protocol.
 *
 * Pure: no node, no electron, no typescript, no DOM. Both sides import this so
 * neither can drift from the other, and the coalescing logic — the part with
 * real behaviour — is testable without spawning a thread.
 *
 * These messages cross a `worker_threads` port, not the IPC boundary, so they
 * are structured-clone shaped rather than zod-validated. Anything that reaches
 * the *renderer* still goes through the zod contract in `ipc-contract.ts`; this
 * protocol stops at the main process.
 */

/* ------------------------------ main → worker ----------------------------- */

export interface BootRequest {
  readonly type: 'boot'
  readonly workspaceRoot: string
  /**
   * One `Int32Array` slot both sides can see, which is how a check is stopped.
   *
   * `getSemanticDiagnostics` is synchronous and uninterruptible from the
   * outside: `port.on('message')` calls the worker's handler synchronously, so
   * nothing is delivered while a check is running and a priority queue inside
   * the worker would reorder nothing. The only way in is memory the checker
   * polls at its own checkpoints, which is exactly what tsserver does with a
   * cancellation file — and what `getCancellationToken` on the LanguageService
   * host is for.
   *
   * Main writes 1 when it sends an interactive query; the worker writes 0 the
   * moment it starts answering one. Optional so a supervisor that never sets it
   * — every unit test's fake worker — simply runs uncancellable checks.
   */
  readonly cancellation?: SharedArrayBuffer
}

export interface FilesChangedRequest {
  readonly type: 'filesChanged'
  /** Workspace-relative, already coalesced by the service. */
  readonly changed: readonly string[]
  readonly removed: readonly string[]
}

export interface OpenDocumentRequest {
  readonly type: 'openDocument'
  readonly relativePath: string
  readonly content: string
  readonly version: number
}

export interface CloseDocumentRequest {
  readonly type: 'closeDocument'
  readonly relativePath: string
}

export interface DependentsRequest {
  readonly type: 'dependents'
  readonly requestId: number
  readonly relativePath: string
  /**
   * Paths to trace the import chain FROM — normally the trigger of the pass that
   * rechecked `relativePath`. Empty asks for no chain.
   */
  readonly from: readonly string[]
}

export interface PingRequest {
  readonly type: 'ping'
  readonly nonce: number
}

/**
 * Everything the editor asks about a cursor, on one message with a `kind`.
 *
 * One message rather than one per feature, and one pending map rather than
 * several, because the correlation, the timeout and the settle-on-restart are
 * identical for all of them — and three copies of a resolver map is three
 * places to forget to clear one. Cloned from the BCC daemon's `query`, which is
 * where the shape was proved.
 *
 * The daemon is worth asking because it has the real program: the real
 * tsconfig, the whole workspace, resolved modules. Monaco's bundled worker has
 * none of those, so what it can say about another file is wrong by
 * construction — which is why `configureLanguageDefaults` switches its
 * definition and reference providers off in the same change that turns these
 * on.
 *
 * Unlike `openDocument`, this NEVER schedules a check. `overlay` sets the
 * daemon's view of the buffer and stops there.
 */
export type LanguageQueryKind = 'definition' | 'references'

export interface LanguageQueryRequest {
  readonly type: 'languageQuery'
  readonly requestId: number
  readonly kind: LanguageQueryKind
  readonly relativePath: string
  /** A UTF-16 code-unit index, as `ITextModel.getOffsetAt` produces. */
  readonly offset: number
  /** The live buffer, or null when the caller has none. */
  readonly overlay: DocumentOverlay | null
}

export type WorkerRequest =
  | BootRequest
  | FilesChangedRequest
  | OpenDocumentRequest
  | CloseDocumentRequest
  | DependentsRequest
  | LanguageQueryRequest
  | PingRequest

/* ------------------------------ worker → main ----------------------------- */

export interface ReadyMessage {
  readonly type: 'ready'
}

export interface StateMessage {
  readonly type: 'state'
  readonly state: CompilerDaemonState
  readonly graph: BuildGraphSummary
  readonly checkedFileCount: number
}

export interface DiagnosticsMessage {
  readonly type: 'diagnostics'
  readonly files: readonly FileDiagnostics[]
  /** True when this completes the current check pass. */
  readonly settled: boolean
}

export interface DependentsResponse {
  readonly type: 'dependentsResult'
  readonly requestId: number
  readonly query: DependencyQuery
}

export interface PongMessage {
  readonly type: 'pong'
  readonly nonce: number
  readonly heapUsedMb: number
  /**
   * Epoch ms at which the current synchronous check began, or null when idle.
   *
   * `getSemanticDiagnostics` cannot be interrupted, so a worker legitimately
   * misses heartbeats while it is working. This is what lets the supervisor
   * tell "busy" from "wedged" instead of killing a healthy worker mid-check.
   */
  readonly busySince: number | null
}

export interface WorkerFailure {
  readonly type: 'failure'
  readonly detail: string
}

/**
 * The daemon's working, for one completed check pass.
 *
 * Sent separately from `diagnostics` rather than folded into it because the two
 * have different audiences and different failure modes. Diagnostics must arrive;
 * a trace is observability and is capped and droppable. Merging them would make
 * a chatty trace able to delay a squiggle.
 */
export interface PassMessage {
  readonly type: 'pass'
  readonly pass: CompilerPass
}

/** Discriminated by the kind that was asked, so the supervisor narrows once. */
export type LanguageQueryAnswer =
  | ({ readonly kind: 'definition' } & DefinitionResult)
  | ({ readonly kind: 'references' } & ReferencesResult)

export interface LanguageQueryResponse {
  readonly type: 'languageQueryResult'
  readonly requestId: number
  readonly result: LanguageQueryAnswer
}

export type WorkerMessage =
  | ReadyMessage
  | StateMessage
  | DiagnosticsMessage
  | DependentsResponse
  | LanguageQueryResponse
  | PongMessage
  | PassMessage
  | WorkerFailure

/**
 * The answer to give when there is none: a daemon that is not running, a query
 * that timed out, a position the program knows nothing about.
 *
 * Total over `LanguageQueryKind` by construction — a new kind is a compile
 * error here. Empty rather than a rejection because Monaco logs a rejected
 * provider as an error and shows the user nothing different, so the two would
 * be indistinguishable except in the console. Same choice `dependentsOf`
 * already makes on timeout.
 */
export function emptyLanguageQueryAnswer<K extends LanguageQueryKind>(
  kind: K
): Extract<LanguageQueryAnswer, { kind: K }> {
  const empty: { [P in LanguageQueryKind]: Extract<LanguageQueryAnswer, { kind: P }> } = {
    definition: { kind: 'definition', locations: [] },
    references: { kind: 'references', locations: [], truncated: false }
  }
  return empty[kind]
}

/* -------------------------------- guards --------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * A worker can post anything, including an uncaught rejection's payload. The
 * supervisor must not crash on a message it does not recognise, so every
 * inbound message is narrowed before use.
 */
export function isWorkerMessage(value: unknown): value is WorkerMessage {
  if (!isRecord(value)) return false
  const { type } = value
  return (
    type === 'ready' ||
    type === 'state' ||
    type === 'diagnostics' ||
    type === 'dependentsResult' ||
    type === 'languageQueryResult' ||
    type === 'pong' ||
    type === 'pass' ||
    type === 'failure'
  )
}

export function isWorkerRequest(value: unknown): value is WorkerRequest {
  if (!isRecord(value)) return false
  const { type } = value
  return (
    type === 'boot' ||
    type === 'filesChanged' ||
    type === 'openDocument' ||
    type === 'closeDocument' ||
    type === 'dependents' ||
    type === 'languageQuery' ||
    type === 'ping'
  )
}

/* ------------------------------- coalescing ------------------------------- */

/**
 * Collapses a queue of per-file diagnostic sets to one entry per file.
 *
 * Last write wins, because each `FileDiagnostics` is the *complete* set for its
 * file rather than a delta — an older entry has nothing to contribute.
 * First-appearance order is preserved so the Problems panel does not reshuffle
 * between batches for no reason.
 *
 * The one rule that is easy to get wrong: an entry whose `diagnostics` array is
 * empty is **kept**. That is the "this file is now clean" signal, and dropping
 * it as an apparently-empty payload is precisely how a fixed error keeps its
 * squiggle until the next unrelated edit.
 */
export function coalesceBatches(
  pending: readonly FileDiagnostics[]
): FileDiagnostics[] {
  const byPath = new Map<string, FileDiagnostics>()

  for (const entry of pending) {
    const existing = byPath.get(entry.relativePath)
    // A late batch for a file already superseded by a newer version is dropped;
    // out-of-order arrival would otherwise resurrect stale diagnostics.
    if (existing !== undefined && existing.version > entry.version) continue
    byPath.set(entry.relativePath, entry)
  }

  return [...byPath.values()]
}

/** Total errors and warnings across a set of files. */
export function countSeverities(files: readonly FileDiagnostics[]): {
  errorCount: number
  warningCount: number
} {
  let errorCount = 0
  let warningCount = 0

  for (const file of files) {
    for (const diagnostic of file.diagnostics) {
      if (diagnostic.severity === 'error') errorCount++
      else if (diagnostic.severity === 'warning') warningCount++
    }
  }

  return { errorCount, warningCount }
}
