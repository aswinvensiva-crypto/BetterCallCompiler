import { createMessageReader, encodeMessage, type FramingProblem } from '../shared/jsonrpc-framing'
import {
  classifyMessage,
  CLIENT_CAPABILITIES,
  flattenHoverContents,
  fromFileUri,
  toFileUri,
  toLspPosition,
  toSourceRange,
  type JsonRpcResponse,
  type LspDiagnostic,
  type LspLocation,
  type LspPublishDiagnosticsParams
} from '../shared/lsp-protocol'
import type { LspServerSpec } from '../shared/lsp-registry'
import type { SourceRange } from '../shared/types'

/**
 * One conversation with one language server.
 *
 * The supervisor above this owns *which* servers run and when they restart;
 * this owns the protocol — the handshake, the correlation of replies to
 * requests, the document sync, and the shutdown. Splitting them that way is
 * what `lang-service.ts` and `lang-worker.ts` already do, and it is what makes
 * this testable: the transport is injected, so every case below runs against a
 * scripted server rather than a real one.
 *
 * ## The handshake is not optional and not reorderable
 *
 * A server may not be sent anything before `initialize`, and may not be sent
 * document notifications before it has answered. Servers differ in how they
 * punish getting this wrong — some reply with an error, some ignore the message
 * silently, rust-analyzer exits — and "silently ignores" is the one that
 * produces a support question rather than a bug report, because the editor
 * looks fine and simply never shows a diagnostic. So requests made before the
 * handshake completes are QUEUED here rather than sent or rejected.
 *
 * ## Requests time out; notifications cannot
 *
 * A notification has no reply by definition, so a lost one is invisible. A
 * request that never returns would otherwise hold its promise forever, and the
 * caller — a Monaco provider — would show a spinner until the window closed.
 * Every request gets a deadline and resolves empty rather than rejecting,
 * because Monaco logs a rejected provider as an error in the user's console.
 */

/* -------------------------------------------------------------------------- */
/*  Transport                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The process, as this module needs it.
 *
 * Narrow on purpose: writing bytes, receiving bytes, receiving stderr, knowing
 * it died, and killing it. A `ChildProcess` satisfies this, and so does a test
 * double with no process behind it at all.
 */
export interface LspTransport {
  write(bytes: Uint8Array): void
  onData(handler: (chunk: Uint8Array) => void): void
  onStderr(handler: (text: string) => void): void
  onExit(handler: (code: number | null, signal: string | null) => void): void
  kill(): void
}

export type LspTransportFactory = (spec: LspServerSpec, workspaceRoot: string) => LspTransport

/* -------------------------------------------------------------------------- */
/*  What the client reports                                                    */
/* -------------------------------------------------------------------------- */

export interface LspClientEvents {
  /** The complete diagnostic set for one file, as the server sees it. */
  onDiagnostics(uri: string, diagnostics: readonly LspDiagnostic[], version: number | null): void
  /** Anything worth a log line: stderr, framing junk, a protocol error. */
  onNotice(notice: string): void
  /** The server process ended. The supervisor decides whether to restart. */
  onExit(code: number | null, signal: string | null): void
}

export interface LspClient {
  readonly spec: LspServerSpec
  /** True once `initialize` has been answered and `initialized` sent. */
  ready(): boolean
  openDocument(path: string, languageId: string, text: string, version: number): void
  changeDocument(path: string, text: string, version: number): void
  closeDocument(path: string): void
  definition(path: string, line: number, column: number): Promise<LspTargetLocation[]>
  references(path: string, line: number, column: number): Promise<LspTargetLocation[]>
  hover(path: string, line: number, column: number): Promise<string | null>
  /** Politely, then not. Resolves once the process is gone or the deadline passes. */
  stop(): Promise<void>
}

export interface LspTargetLocation {
  readonly path: string
  readonly range: SourceRange
}

/* -------------------------------------------------------------------------- */
/*  Timings                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Generous, because these are cold starts.
 *
 * rust-analyzer indexing a workspace before answering `initialize` is routine
 * and can take tens of seconds on a large crate. A short deadline here would
 * declare a working server dead exactly on the projects where it is most
 * useful.
 */
const INITIALIZE_TIMEOUT_MS = 30_000

/**
 * Short, because these are user-invoked and the user is waiting.
 *
 * A definition that arrives after three seconds is not useful — the user has
 * already pressed something else — and holding the promise open past that only
 * delays the fallback.
 */
const REQUEST_TIMEOUT_MS = 3_000

/** How long a server gets to exit on its own before being killed. */
const SHUTDOWN_GRACE_MS = 1_000

/* -------------------------------------------------------------------------- */
/*  Implementation                                                             */
/* -------------------------------------------------------------------------- */

interface Pending {
  readonly resolve: (value: unknown) => void
  readonly timer: ReturnType<typeof setTimeout>
}

export function createLspClient(
  spec: LspServerSpec,
  workspaceRoot: string,
  transport: LspTransport,
  events: LspClientEvents
): LspClient {
  const reader = createMessageReader()
  const pending = new Map<number, Pending>()

  /*
   * Queued until the handshake finishes. Not rejected and not dropped: a
   * `didOpen` that arrives during startup is the common case — the user already
   * had a file open when the server was spawned — and losing it means that file
   * never gets diagnostics for the whole session.
   */
  const queued: unknown[] = []

  let nextId = 1
  let initialised = false
  let stopped = false
  const open = new Set<string>()

  /* ------------------------------- plumbing ------------------------------- */

  function send(message: unknown): void {
    if (stopped) return
    transport.write(encodeMessage(message))
  }

  function sendOrQueue(message: unknown): void {
    if (initialised) send(message)
    else queued.push(message)
  }

  function request<T>(method: string, params: unknown, timeoutMs: number): Promise<T | null> {
    if (stopped) return Promise.resolve(null)

    const id = nextId++
    return new Promise<T | null>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        events.onNotice(`${spec.id}: ${method} timed out after ${timeoutMs}ms`)
        // Empty, never a rejection: Monaco logs a rejected provider as an error
        // in the user's console, and a slow server is not the user's problem.
        resolve(null)
      }, timeoutMs)

      timer.unref?.()
      pending.set(id, { resolve: resolve as (value: unknown) => void, timer })
      sendOrQueue({ jsonrpc: '2.0', id, method, params })
    })
  }

  function settle(response: JsonRpcResponse): void {
    if (typeof response.id !== 'number') return
    const waiting = pending.get(response.id)
    if (waiting === undefined) return

    pending.delete(response.id)
    clearTimeout(waiting.timer)

    if (response.error !== undefined) {
      events.onNotice(`${spec.id}: ${response.error.message}`)
      waiting.resolve(null)
      return
    }

    waiting.resolve(response.result ?? null)
  }

  /* ------------------------------- receiving ------------------------------ */

  function handleNotification(method: string, params: unknown): void {
    if (method !== 'textDocument/publishDiagnostics') return

    const payload = params as LspPublishDiagnosticsParams | undefined
    if (payload === undefined || typeof payload.uri !== 'string') return

    events.onDiagnostics(
      payload.uri,
      Array.isArray(payload.diagnostics) ? payload.diagnostics : [],
      typeof payload.version === 'number' ? payload.version : null
    )
  }

  /**
   * A request FROM the server.
   *
   * Several are mandatory to answer even when the answer is "no". `client/
   * registerCapability` in particular is sent by gopls and rust-analyzer during
   * startup, and a server that never gets its reply waits rather than
   * proceeding — the session then looks hung with nothing in any log.
   */
  function handleServerRequest(id: unknown, method: string): void {
    switch (method) {
      case 'client/registerCapability':
      case 'client/unregisterCapability':
      case 'workspace/didChangeWatchedFiles':
        send({ jsonrpc: '2.0', id, result: null })
        return
      case 'window/workDoneProgress/create':
        send({ jsonrpc: '2.0', id, result: null })
        return
      default:
        // MethodNotFound. Answering "no" is required; staying silent is not an
        // option the protocol leaves open.
        send({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `${method} is not supported by this client` }
        })
    }
  }

  function receive(chunk: Uint8Array): void {
    const { messages, problems } = reader.push(chunk)

    for (const problem of problems) noteProblem(problem)

    for (const framed of messages) {
      let parsed: unknown
      try {
        parsed = JSON.parse(framed.body)
      } catch {
        events.onNotice(`${spec.id}: sent a message that is not JSON`)
        continue
      }

      const record = parsed as Record<string, unknown>
      switch (classifyMessage(parsed)) {
        case 'response':
          settle(parsed as JsonRpcResponse)
          break
        case 'notification':
          handleNotification(String(record['method']), record['params'])
          break
        case 'request':
          handleServerRequest(record['id'], String(record['method']))
          break
        default:
          events.onNotice(`${spec.id}: sent something that is not a JSON-RPC message`)
      }
    }
  }

  function noteProblem(problem: FramingProblem): void {
    // Framing junk is expected from some servers and is not worth alarming
    // about; a buffer overflow means something is genuinely wrong.
    if (problem.reason === 'skipped-non-protocol-bytes') return
    events.onNotice(`${spec.id}: ${problem.reason} — ${problem.detail}`)
  }

  /* ------------------------------- handshake ------------------------------ */

  async function handshake(): Promise<void> {
    /*
     * `initialize` must be sent directly rather than through `sendOrQueue`,
     * which would queue it behind the flag it is responsible for setting.
     */
    const id = nextId++
    const answered = new Promise<unknown>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        events.onNotice(`${spec.id}: did not answer initialize within ${INITIALIZE_TIMEOUT_MS}ms`)
        resolve(null)
      }, INITIALIZE_TIMEOUT_MS)
      timer.unref?.()
      pending.set(id, { resolve, timer })
    })

    send({
      jsonrpc: '2.0',
      id,
      method: 'initialize',
      params: {
        processId: typeof process === 'undefined' ? null : process.pid,
        clientInfo: { name: 'BetterCallCompiler' },
        rootUri: toFileUri(workspaceRoot),
        workspaceFolders: [{ uri: toFileUri(workspaceRoot), name: 'workspace' }],
        capabilities: CLIENT_CAPABILITIES
      }
    })

    const result = await answered
    if (stopped) return

    // Even on a timeout the client proceeds: some servers answer late and work
    // afterwards, and the alternative is a session that can never recover.
    if (result === null) events.onNotice(`${spec.id}: proceeding without an initialize result`)

    send({ jsonrpc: '2.0', method: 'initialized', params: {} })
    initialised = true

    for (const message of queued.splice(0)) send(message)
  }

  /* ------------------------------ documents ------------------------------- */

  function openDocument(path: string, languageId: string, text: string, version: number): void {
    const uri = toFileUri(path)
    open.add(uri)
    sendOrQueue({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: { textDocument: { uri, languageId, version, text } }
    })
  }

  function changeDocument(path: string, text: string, version: number): void {
    const uri = toFileUri(path)
    // A change for a document the server was never told about is a protocol
    // error on most servers and a crash on some. Promote it to an open.
    if (!open.has(uri)) {
      openDocument(path, spec.languageIds[0] ?? 'plaintext', text, version)
      return
    }

    sendOrQueue({
      jsonrpc: '2.0',
      method: 'textDocument/didChange',
      params: {
        textDocument: { uri, version },
        // Full-document sync. Incremental would send less, and would mean this
        // client had to keep its own copy of every buffer and stay in step with
        // Monaco's edits — a second source of truth for text, which is the bug
        // class `openDocument` in the TypeScript daemon already had once.
        contentChanges: [{ text }]
      }
    })
  }

  function closeDocument(path: string): void {
    const uri = toFileUri(path)
    if (!open.delete(uri)) return
    sendOrQueue({ jsonrpc: '2.0', method: 'textDocument/didClose', params: { textDocument: { uri } } })
  }

  /* ------------------------------- queries -------------------------------- */

  function locationsOf(result: unknown): LspTargetLocation[] {
    /*
     * Three shapes again: `Location`, `Location[]`, and `LocationLink[]` — the
     * last with `targetUri`/`targetSelectionRange` instead of `uri`/`range`.
     * Servers choose per capability and per version, so all three are handled.
     */
    const raw = Array.isArray(result) ? result : result === null || result === undefined ? [] : [result]
    const located: LspTargetLocation[] = []

    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null) continue
      const record = entry as Record<string, unknown>

      const uri = typeof record['uri'] === 'string' ? record['uri'] : record['targetUri']
      const range = record['range'] ?? record['targetSelectionRange'] ?? record['targetRange']
      if (typeof uri !== 'string' || typeof range !== 'object' || range === null) continue

      const path = fromFileUri(uri)
      if (path === null) continue

      located.push({ path, range: toSourceRange(range as LspLocation['range']) })
    }

    return located
  }

  async function definition(path: string, line: number, column: number): Promise<LspTargetLocation[]> {
    const result = await request('textDocument/definition', positionParams(path, line, column), REQUEST_TIMEOUT_MS)
    return locationsOf(result)
  }

  async function references(path: string, line: number, column: number): Promise<LspTargetLocation[]> {
    const result = await request(
      'textDocument/references',
      { ...positionParams(path, line, column), context: { includeDeclaration: true } },
      REQUEST_TIMEOUT_MS
    )
    return locationsOf(result)
  }

  async function hover(path: string, line: number, column: number): Promise<string | null> {
    const result = await request<{ contents?: unknown }>(
      'textDocument/hover',
      positionParams(path, line, column),
      REQUEST_TIMEOUT_MS
    )
    if (result === null || typeof result !== 'object') return null

    const text = flattenHoverContents(result.contents)
    return text === '' ? null : text
  }

  function positionParams(
    path: string,
    line: number,
    column: number
  ): { textDocument: { uri: string }; position: { line: number; character: number } } {
    return {
      textDocument: { uri: toFileUri(path) },
      position: toLspPosition(line, column)
    }
  }

  /* ------------------------------- shutdown ------------------------------- */

  async function stop(): Promise<void> {
    if (stopped) return
    /*
     * The polite sequence is `shutdown` then `exit`, and it matters: a server
     * killed mid-write can leave an index or a cache half-written, and
     * rust-analyzer's is expensive enough that the next session pays for it.
     * But politeness has a deadline — a wedged server must not keep the app
     * from closing.
     */
    send({ jsonrpc: '2.0', id: nextId++, method: 'shutdown' })
    send({ jsonrpc: '2.0', method: 'exit' })

    stopped = true

    for (const waiting of pending.values()) {
      clearTimeout(waiting.timer)
      waiting.resolve(null)
    }
    pending.clear()

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        transport.kill()
        resolve()
      }, SHUTDOWN_GRACE_MS)
      timer.unref?.()
      transport.onExit(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  /* ------------------------------- wiring --------------------------------- */

  transport.onData(receive)
  transport.onStderr((text) => {
    const trimmed = text.trim()
    if (trimmed !== '') events.onNotice(`${spec.id} stderr: ${trimmed}`)
  })
  transport.onExit((code, signal) => {
    if (stopped) return
    // Settle everything in flight. A caller left waiting on a dead server is
    // the leak `scheduleRestart` in the TypeScript daemon had, found by
    // writing its crash test.
    for (const waiting of pending.values()) {
      clearTimeout(waiting.timer)
      waiting.resolve(null)
    }
    pending.clear()
    initialised = false
    events.onExit(code, signal)
  })

  void handshake()

  return {
    spec,
    ready: () => initialised,
    openDocument,
    changeDocument,
    closeDocument,
    definition,
    references,
    hover,
    stop
  }
}
