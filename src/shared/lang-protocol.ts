import type { FileDiagnostics } from './types'

/**
 * The BCC worker ↔ main message protocol.
 *
 * Deliberately a separate protocol from `compiler-protocol.ts` rather than an
 * extension of it, for the same reason the workers are separate: the failure
 * domains are separate. A change to how the TypeScript daemon reports its
 * dependency graph must not be able to break BCC, and a crash in one must not
 * take the other down.
 *
 * It is also much smaller, and that is the language rather than laziness.
 * **BCC has no imports**, so there is no dependency graph, no invalidation set,
 * no cycle detection and no signature cutoff to report — one file changing
 * affects exactly one file. Every message the TypeScript protocol carries for
 * cross-file work is absent because there is no cross-file work to do.
 *
 * Pure: no node, no electron, no typescript, no DOM. Structured-clone shaped
 * rather than zod-validated, because this crosses a `worker_threads` port and
 * stops at the main process — anything reaching the renderer still goes through
 * `ipc-contract.ts`.
 */

/* ------------------------------ main → worker ----------------------------- */

export interface LangBootRequest {
  readonly type: 'boot'
  readonly workspaceRoot: string
}

export interface LangFilesChangedRequest {
  readonly type: 'filesChanged'
  /** Workspace-relative, already coalesced and filtered to `.bcc` by the service. */
  readonly changed: readonly string[]
  readonly removed: readonly string[]
}

export interface LangOpenDocumentRequest {
  readonly type: 'openDocument'
  readonly relativePath: string
  readonly content: string
  readonly version: number
}

export interface LangCloseDocumentRequest {
  readonly type: 'closeDocument'
  readonly relativePath: string
}

export interface LangPingRequest {
  readonly type: 'ping'
  readonly nonce: number
}

export type LangRequest =
  | LangBootRequest
  | LangFilesChangedRequest
  | LangOpenDocumentRequest
  | LangCloseDocumentRequest
  | LangPingRequest

/* ------------------------------ worker → main ----------------------------- */

export interface LangReadyMessage {
  readonly type: 'ready'
}

export interface LangDiagnosticsMessage {
  readonly type: 'diagnostics'
  readonly files: readonly FileDiagnostics[]
  /** True when this completes the current check. Always true today: see below. */
  readonly settled: boolean
}

/**
 * Answered on every ping.
 *
 * There is no `busySince` here, unlike the TypeScript daemon's pong. That field
 * exists because `getSemanticDiagnostics` is synchronous and uninterruptible,
 * so a healthy worker legitimately misses heartbeats and the supervisor needs
 * to tell "busy" from "wedged". Lexing and parsing one BCC file is
 * microseconds, so a missed heartbeat here is never legitimate — it means a
 * loop that does not terminate, which is exactly what the heartbeat should kill.
 */
export interface LangPongMessage {
  readonly type: 'pong'
  readonly nonce: number
  readonly heapUsedMb: number
}

/** Indexing finished. Carries the count so a caller can tell "none" from "not yet". */
export interface LangIndexedMessage {
  readonly type: 'indexed'
  readonly fileCount: number
}

export interface LangFailureMessage {
  readonly type: 'failure'
  readonly detail: string
}

export type LangMessage =
  | LangReadyMessage
  | LangDiagnosticsMessage
  | LangPongMessage
  | LangIndexedMessage
  | LangFailureMessage

/* -------------------------------- guards --------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * A worker can post anything, including an uncaught rejection's payload. The
 * supervisor must not crash on a message it does not recognise.
 */
export function isLangMessage(value: unknown): value is LangMessage {
  if (!isRecord(value)) return false
  const { type } = value
  return (
    type === 'ready' ||
    type === 'diagnostics' ||
    type === 'pong' ||
    type === 'indexed' ||
    type === 'failure'
  )
}

export function isLangRequest(value: unknown): value is LangRequest {
  if (!isRecord(value)) return false
  const { type } = value
  return (
    type === 'boot' ||
    type === 'filesChanged' ||
    type === 'openDocument' ||
    type === 'closeDocument' ||
    type === 'ping'
  )
}
