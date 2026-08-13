import type {
  BuildGraphSummary,
  CompilerDaemonState,
  CompilerPass,
  DependencyQuery,
  FileDiagnostics
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
}

export interface PingRequest {
  readonly type: 'ping'
  readonly nonce: number
}

export type WorkerRequest =
  | BootRequest
  | FilesChangedRequest
  | OpenDocumentRequest
  | CloseDocumentRequest
  | DependentsRequest
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

export type WorkerMessage =
  | ReadyMessage
  | StateMessage
  | DiagnosticsMessage
  | DependentsResponse
  | PongMessage
  | PassMessage
  | WorkerFailure

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
