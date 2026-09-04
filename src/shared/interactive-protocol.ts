import type {
  CompletionDetailResult,
  CompletionsResult,
  DocumentOverlay,
  HoverResult,
  SignatureHelpResult
} from './types'

/**
 * The interactive worker's protocol.
 *
 * A third worker, and a third protocol, for the reason the second one exists:
 * failure domains stay separate. This one holds a `ts.LanguageService` and
 * answers hover, completions and signature help — and nothing else. It never
 * checks, never publishes a diagnostic and never touches the query engine.
 *
 * ## Why it is not the check worker
 *
 * These are asked at keystroke frequency and are only correct with the whole
 * program. Asking the check worker would mean cancelling its check on every
 * character — and a check that is cancelled on every character never converges,
 * so the squiggles would stop appearing while you type, which is exactly when
 * you want them. A5's answer is a second, read-only LanguageService that is
 * never interrupted, at the cost of a second type checker's memory.
 *
 * ## Why it is not Monaco's worker
 *
 * Monaco's has no tsconfig, no file system and no module resolution, so what it
 * can say about a symbol imported from another file is a guess. It stays as the
 * fallback — see `CompilerStatus.interactive` — because a guess beats nothing
 * while this one is starting, and because a worker that fails to start should
 * degrade to what shipped before rather than to silence.
 *
 * Pure: no node, no electron, no typescript, no DOM.
 */

/* ------------------------------ main → worker ----------------------------- */

export interface InteractiveBootRequest {
  readonly type: 'boot'
  readonly workspaceRoot: string
}

export interface InteractiveFilesChangedRequest {
  readonly type: 'filesChanged'
  readonly changed: readonly string[]
  readonly removed: readonly string[]
}

export interface InteractiveOpenDocumentRequest {
  readonly type: 'openDocument'
  readonly relativePath: string
  readonly content: string
  readonly version: number
}

export interface InteractiveCloseDocumentRequest {
  readonly type: 'closeDocument'
  readonly relativePath: string
}

export interface InteractivePingRequest {
  readonly type: 'ping'
  readonly nonce: number
}

export type InteractiveQueryKind = 'hover' | 'completions' | 'completionDetail' | 'signatureHelp'

export interface InteractiveQueryRequest {
  readonly type: 'query'
  readonly requestId: number
  readonly kind: InteractiveQueryKind
  readonly relativePath: string
  /** A UTF-16 code-unit index, as `ITextModel.getOffsetAt` produces. */
  readonly offset: number
  /**
   * Completion detail only: which entry to describe.
   *
   * `source` is what distinguishes two identically named auto-import
   * candidates from different modules, so it rides along rather than being
   * re-derived from a label that cannot carry it.
   */
  readonly entryName: string | null
  readonly entrySource: string | null
  /** The live buffer. Always sent for these: they are answered AT a keystroke. */
  readonly overlay: DocumentOverlay | null
}

export type InteractiveRequest =
  | InteractiveBootRequest
  | InteractiveFilesChangedRequest
  | InteractiveOpenDocumentRequest
  | InteractiveCloseDocumentRequest
  | InteractiveQueryRequest
  | InteractivePingRequest

/* ------------------------------ worker → main ----------------------------- */

export interface InteractiveReadyMessage {
  readonly type: 'ready'
}

/** The program is built and the first answer will not pay for constructing it. */
export interface InteractiveIndexedMessage {
  readonly type: 'indexed'
  readonly fileCount: number
}

export interface InteractivePongMessage {
  readonly type: 'pong'
  readonly nonce: number
  readonly heapUsedMb: number
}

export type InteractiveQueryAnswer =
  | ({ readonly kind: 'hover' } & HoverResult)
  | ({ readonly kind: 'completions' } & CompletionsResult)
  | ({ readonly kind: 'completionDetail' } & CompletionDetailResult)
  | ({ readonly kind: 'signatureHelp' } & SignatureHelpResult)

export interface InteractiveQueryResultMessage {
  readonly type: 'queryResult'
  readonly requestId: number
  readonly result: InteractiveQueryAnswer
}

export interface InteractiveFailureMessage {
  readonly type: 'failure'
  readonly detail: string
}

export type InteractiveMessage =
  | InteractiveReadyMessage
  | InteractiveIndexedMessage
  | InteractivePongMessage
  | InteractiveQueryResultMessage
  | InteractiveFailureMessage

/**
 * The answer to give when there is none.
 *
 * Total over `InteractiveQueryKind` by construction — a new kind is a compile
 * error here. Empty rather than a rejection for the reason every other provider
 * in this codebase resolves: Monaco logs a rejected provider as a console error
 * and shows the user nothing different.
 */
export function emptyInteractiveAnswer<K extends InteractiveQueryKind>(
  kind: K
): Extract<InteractiveQueryAnswer, { kind: K }> {
  const empty: {
    [P in InteractiveQueryKind]: Extract<InteractiveQueryAnswer, { kind: P }>
  } = {
    hover: { kind: 'hover', contents: null, range: null },
    completions: { kind: 'completions', items: [], incomplete: false },
    completionDetail: { kind: 'completionDetail', detail: null, documentation: null },
    signatureHelp: {
      kind: 'signatureHelp',
      signatures: [],
      activeSignature: 0,
      activeParameter: 0
    }
  }
  return empty[kind]
}

/* -------------------------------- guards --------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function isInteractiveMessage(value: unknown): value is InteractiveMessage {
  if (!isRecord(value)) return false
  const { type } = value
  return (
    type === 'ready' ||
    type === 'indexed' ||
    type === 'pong' ||
    type === 'queryResult' ||
    type === 'failure'
  )
}

export function isInteractiveRequest(value: unknown): value is InteractiveRequest {
  if (!isRecord(value)) return false
  const { type } = value
  return (
    type === 'boot' ||
    type === 'filesChanged' ||
    type === 'openDocument' ||
    type === 'closeDocument' ||
    type === 'query' ||
    type === 'ping'
  )
}
