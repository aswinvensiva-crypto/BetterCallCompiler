import type {
  CompilerPass,
  DefinitionResult,
  DocumentOverlay,
  DocumentSymbolsResult,
  FileDiagnostics,
  HoverResult,
  ObservatorySnapshot,
  ReferencesResult,
  RenameResult
} from './types'

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

/**
 * Everything the editor asks about a cursor, on one message with a `kind`
 * discriminant.
 *
 * One message rather than five, and one pending map rather than five, because
 * the correlation, the timeout and the cleanup-on-restart are identical for all
 * of them and three copies of a resolver map is three places to forget to clear
 * one. The `kind` is what the answer's shape is keyed on.
 *
 * Unlike `openDocument`, this NEVER schedules a check. `overlay` sets the
 * daemon's copy of the buffer and stops there — see `documentOverlaySchema` for
 * why an interactive request cannot trust the 300ms-debounced overlay.
 */
export type LangQueryKind =
  | 'definition'
  | 'references'
  | 'rename'
  | 'documentSymbols'
  | 'hover'

export interface LangQueryRequest {
  readonly type: 'query'
  /** Correlates the answer. Monotonic in the service, never reused. */
  readonly requestId: number
  readonly kind: LangQueryKind
  readonly relativePath: string
  /** A UTF-16 code-unit index, as `ITextModel.getOffsetAt` produces. */
  readonly offset: number
  /** Rename only: null asks where the symbol is, a name asks for the edits. */
  readonly newName: string | null
  /** The live buffer, or null when the caller has none (a closed file). */
  readonly overlay: DocumentOverlay | null
}

/**
 * Part 11: every stage of one file, for the Observatory.
 *
 * A separate message from `LangQueryRequest` rather than a sixth `kind` on it.
 * That union answers a question about ONE OFFSET and is engineered around
 * that — `respond()` reads `parsed`/`resolution`/`types` for the file and
 * narrows from there. This asks for the whole file's pipeline output, keeps no
 * offset, and its answer is an order of magnitude bigger, so it does not belong
 * on the keystroke-shaped path the query timeout and the interactive-worker
 * split were built for.
 */
export interface LangObservatoryRequest {
  readonly type: 'observatory'
  readonly requestId: number
  readonly relativePath: string
  readonly overlay: DocumentOverlay | null
}

export type LangRequest =
  | LangBootRequest
  | LangFilesChangedRequest
  | LangOpenDocumentRequest
  | LangCloseDocumentRequest
  | LangQueryRequest
  | LangObservatoryRequest
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

/**
 * The answer to a `query`, discriminated by the kind that was asked.
 *
 * A union rather than a bag of optional fields, so the supervisor can narrow to
 * exactly one shape and a handler that asked for a hover cannot accidentally
 * read `locations`. The narrowing happens once, in `lang-service.ts`.
 */
export type LangQueryResult =
  | ({ readonly kind: 'definition' } & DefinitionResult)
  | ({ readonly kind: 'references' } & ReferencesResult)
  | ({ readonly kind: 'rename' } & RenameResult)
  | ({ readonly kind: 'documentSymbols' } & DocumentSymbolsResult)
  | ({ readonly kind: 'hover' } & HoverResult)

export interface LangQueryResultMessage {
  readonly type: 'queryResult'
  readonly requestId: number
  readonly result: LangQueryResult
}

export interface LangObservatoryResultMessage {
  readonly type: 'observatoryResult'
  readonly requestId: number
  readonly snapshot: ObservatorySnapshot
}

/**
 * Part 12, made visible: the same `CompilerPass` shape the TypeScript daemon
 * posts, so `compiler-service.ts` can fold both into one history without the
 * renderer needing to know two compilers exist. Posted after every `check()`
 * pass AND after every `observatory` request, since asking the Observatory for
 * IR/SSA/passes is itself demand-driven work the engine can answer from memo —
 * and a panel that only showed the check pipeline's reuse would be showing half
 * the claim.
 */
export interface LangPassMessage {
  readonly type: 'pass'
  readonly pass: CompilerPass
}

export type LangMessage =
  | LangReadyMessage
  | LangDiagnosticsMessage
  | LangPongMessage
  | LangIndexedMessage
  | LangQueryResultMessage
  | LangObservatoryResultMessage
  | LangPassMessage
  | LangFailureMessage

/**
 * The answer to give when there is none: a daemon that is not running, a query
 * that timed out, a file the worker has never heard of.
 *
 * Total over `LangQueryKind` by construction — a new kind is a compile error
 * here, which is the point. Empty rather than a rejection because Monaco logs a
 * rejected provider as an error in the console and shows the user nothing
 * different, so "no answer" and "failed" would be indistinguishable except in
 * the log. Same choice `dependentsOf` already makes on timeout.
 */
export function emptyLangQueryResult<K extends LangQueryKind>(
  kind: K
): Extract<LangQueryResult, { kind: K }> {
  const empty: { [P in LangQueryKind]: Extract<LangQueryResult, { kind: P }> } = {
    definition: { kind: 'definition', locations: [] },
    references: { kind: 'references', locations: [], truncated: false },
    rename: { kind: 'rename', target: null, placeholder: null, files: [], error: null },
    documentSymbols: { kind: 'documentSymbols', symbols: [] },
    hover: { kind: 'hover', contents: null, range: null }
  }
  return empty[kind]
}

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
    type === 'queryResult' ||
    type === 'observatoryResult' ||
    type === 'pass' ||
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
    type === 'query' ||
    type === 'observatory' ||
    type === 'ping'
  )
}
