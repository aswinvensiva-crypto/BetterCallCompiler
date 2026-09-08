import {
  type DiagnosticMessage,
  type DiagnosticSeverity,
  type SourceRange
} from './types'

/**
 * The slice of the Language Server Protocol this client speaks, and the
 * conversions between it and the shapes the rest of the app already uses.
 *
 * Deliberately a subset. LSP is enormous and most of it is optional on both
 * sides; what is here is what turns a language server into diagnostics,
 * navigation and hover — the same four questions Workstream A already built
 * providers and panels for. Anything a server offers beyond this is simply not
 * requested, which the protocol makes a first-class option through
 * capabilities.
 *
 * ## Positions are the whole hazard
 *
 * LSP is **zero-based** in both line and character. Everything in this
 * repository is **one-based**, from `src/lang/token.ts`'s spans through
 * `sourceRangeSchema` to Monaco's own API. So every position crossing this
 * boundary needs +1 or -1, and getting it wrong produces a diagnostic
 * underlining the character before the one that is wrong, or a go-to-definition
 * landing one line high.
 *
 * That class of bug is nearly invisible in a screenshot and very visible to
 * someone using the editor, so the conversion lives in two named functions with
 * tests rather than being open-coded at each call site. There are four call
 * sites already and there will be more.
 *
 * LSP also counts characters in **UTF-16 code units** by default, which matches
 * JavaScript strings and therefore matches Monaco. That is the one place the
 * protocol's default and ours agree for free, and it is worth stating because
 * the obvious "fix" — treating them as bytes, as the framing does — would be
 * wrong.
 */

/* -------------------------------------------------------------------------- */
/*  Wire types                                                                 */
/* -------------------------------------------------------------------------- */

/** Zero-based, UTF-16 code units. */
export interface LspPosition {
  readonly line: number
  readonly character: number
}

export interface LspRange {
  readonly start: LspPosition
  readonly end: LspPosition
}

export interface LspLocation {
  readonly uri: string
  readonly range: LspRange
}

/** 1 error, 2 warning, 3 information, 4 hint. Absent means "up to the client". */
export type LspDiagnosticSeverity = 1 | 2 | 3 | 4

export interface LspDiagnostic {
  readonly range: LspRange
  readonly severity?: LspDiagnosticSeverity
  readonly code?: string | number
  readonly source?: string
  readonly message: string
}

export interface LspPublishDiagnosticsParams {
  readonly uri: string
  readonly version?: number
  readonly diagnostics: readonly LspDiagnostic[]
}

/** What the client tells the server it can do. */
export interface LspClientCapabilities {
  readonly textDocument: {
    readonly synchronization: { readonly dynamicRegistration: false }
    readonly publishDiagnostics: { readonly relatedInformation: false }
    readonly definition: { readonly dynamicRegistration: false }
    readonly references: { readonly dynamicRegistration: false }
    readonly hover: { readonly contentFormat: readonly ['plaintext', 'markdown'] }
  }
}

/**
 * Stated once, honestly.
 *
 * Claiming a capability the client does not implement is worse than claiming
 * none: the server then sends things nobody handles, and on some servers
 * changes its behaviour to match. Every entry here corresponds to code that
 * exists.
 */
export const CLIENT_CAPABILITIES: LspClientCapabilities = {
  textDocument: {
    synchronization: { dynamicRegistration: false },
    publishDiagnostics: { relatedInformation: false },
    definition: { dynamicRegistration: false },
    references: { dynamicRegistration: false },
    hover: { contentFormat: ['plaintext', 'markdown'] }
  }
}

/* -------------------------------------------------------------------------- */
/*  JSON-RPC envelopes                                                         */
/* -------------------------------------------------------------------------- */

export interface JsonRpcRequest {
  readonly jsonrpc: '2.0'
  readonly id: number
  readonly method: string
  readonly params?: unknown
}

export interface JsonRpcNotification {
  readonly jsonrpc: '2.0'
  readonly method: string
  readonly params?: unknown
}

export interface JsonRpcError {
  readonly code: number
  readonly message: string
  readonly data?: unknown
}

export interface JsonRpcResponse {
  readonly jsonrpc: '2.0'
  readonly id: number | null
  readonly result?: unknown
  readonly error?: JsonRpcError
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse

/**
 * Which of the three shapes a decoded body is.
 *
 * The discriminator is structural rather than a field, because JSON-RPC does
 * not carry one: a response has `id` and no `method`, a request has both, a
 * notification has `method` and no `id`. Getting this wrong means answering a
 * notification (which servers reject) or leaving a request unanswered (which
 * hangs the server waiting).
 */
export function classifyMessage(
  message: unknown
): 'request' | 'notification' | 'response' | 'unknown' {
  if (typeof message !== 'object' || message === null) return 'unknown'

  const record = message as Record<string, unknown>
  const hasMethod = typeof record['method'] === 'string'
  // `id: null` is a legal response id — for an error against a request the
  // server could not parse — so presence, not truthiness.
  const hasId = 'id' in record && record['id'] !== undefined

  if (hasMethod && hasId) return 'request'
  if (hasMethod) return 'notification'
  if (hasId) return 'response'
  return 'unknown'
}

/* -------------------------------------------------------------------------- */
/*  Positions                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * LSP's zero-based range as this app's one-based one.
 *
 * Also clamps: `sourceRangeSchema` requires positive integers, and a server
 * that reports a negative or fractional position — clangd has been known to
 * emit `-1` for a diagnostic with no location — would otherwise produce a
 * payload that fails validation at the IPC boundary and takes the whole batch
 * with it. One bad diagnostic should cost that diagnostic, not the file.
 */
export function toSourceRange(range: LspRange): SourceRange {
  return {
    startLine: oneBased(range.start.line),
    startColumn: oneBased(range.start.character),
    endLine: oneBased(range.end.line),
    endColumn: oneBased(range.end.character)
  }
}

/** This app's one-based position as LSP's zero-based one. */
export function toLspPosition(line: number, column: number): LspPosition {
  return { line: Math.max(0, Math.trunc(line) - 1), character: Math.max(0, Math.trunc(column) - 1) }
}

function oneBased(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.max(1, Math.trunc(value) + 1)
}

/* -------------------------------------------------------------------------- */
/*  URIs                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A `file:` URI for an absolute path.
 *
 * Written here rather than reached for from node, because `src/shared` is pure
 * and because node's own `pathToFileURL` is not available in the renderer half
 * of the app that also needs to read these.
 *
 * Windows is the whole complication. `C:\a\b` becomes `file:///c%3A/a/b` in
 * some encoders and `file:///C:/a/b` in others; servers vary in which they
 * accept, and the drive letter's case varies with how the path was obtained.
 * This produces the form every major server accepts — three slashes, an
 * unescaped colon, the drive letter as given — and `fromFileUri` reverses
 * exactly it.
 */
export function toFileUri(absolutePath: string): string {
  const normalised = absolutePath.replace(/\\/g, '/')
  const withRoot = normalised.startsWith('/') ? normalised : `/${normalised}`

  return `file://${withRoot
    .split('/')
    .map((segment, index) =>
      // The drive-letter segment keeps its colon; everything else is escaped.
      index === 1 && /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)
    )
    .join('/')}`
}

/** The absolute path a `file:` URI names, or null when it is not one. */
export function fromFileUri(uri: string): string | null {
  if (!uri.startsWith('file://')) return null

  const withoutScheme = decodeURIComponent(uri.slice('file://'.length))
  // `/C:/a/b` is a Windows path with a leading slash the URI form requires.
  if (/^\/[A-Za-z]:/.test(withoutScheme)) return withoutScheme.slice(1)
  return withoutScheme
}

/* -------------------------------------------------------------------------- */
/*  Diagnostics                                                                */
/* -------------------------------------------------------------------------- */

const SEVERITY: Readonly<Record<LspDiagnosticSeverity, DiagnosticSeverity>> = {
  1: 'error',
  2: 'warning',
  3: 'info',
  4: 'hint'
}

/**
 * An LSP diagnostic as the shape the Problems panel and Monaco already render.
 *
 * This one function is what makes an LSP client worth building rather than
 * merely possible: emitting the existing `DiagnosticMessage` buys the Problems
 * panel, the marker mapping, the clean-sweep semantics and the status bar
 * unchanged — the same trick Part 3 used to give BCC squiggles for free.
 *
 * A missing severity becomes an error rather than being dropped. The spec says
 * the client decides, and every editor decides "error": a server that omits it
 * is reporting something it considers a problem, and hiding it because a field
 * was absent is the wrong failure.
 */
export function toDiagnosticMessage(
  diagnostic: LspDiagnostic,
  relativePath: string,
  path: string,
  serverId: string
): DiagnosticMessage {
  const range = toSourceRange(diagnostic.range)

  return {
    relativePath,
    path,
    severity: SEVERITY[diagnostic.severity ?? 1] ?? 'error',
    // The server's own code where there is one, else its name — so a row in
    // Problems always says who produced it and never reads as blank.
    code: diagnostic.code === undefined ? serverId : String(diagnostic.code),
    message: diagnostic.message,
    startLine: range.startLine,
    startColumn: range.startColumn,
    endLine: range.endLine,
    endColumn: range.endColumn,
    source: 'lsp'
  }
}

/* -------------------------------------------------------------------------- */
/*  Hover                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Hover contents flattened to one string.
 *
 * The field is a union of four shapes across protocol versions — a string, a
 * `{language, value}` pair, a `{kind, value}` markup object, or an array mixing
 * them — and servers in current use emit all four. Handling one and ignoring
 * the rest produces an empty tooltip against exactly the servers that were not
 * tested, so all four are handled here and the renderer sees a string.
 */
export function flattenHoverContents(contents: unknown): string {
  if (typeof contents === 'string') return contents

  if (Array.isArray(contents)) {
    return contents
      .map((entry) => flattenHoverContents(entry))
      .filter((entry) => entry !== '')
      .join('\n\n')
  }

  if (typeof contents === 'object' && contents !== null) {
    const record = contents as Record<string, unknown>
    const value = record['value']
    if (typeof value !== 'string') return ''

    // `{language, value}` is a code block in a named language; `{kind, value}`
    // is already markdown or plain text.
    const language = record['language']
    return typeof language === 'string' ? `\`\`\`${language}\n${value}\n\`\`\`` : value
  }

  return ''
}
