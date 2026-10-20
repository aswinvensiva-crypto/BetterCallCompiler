import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMessageReader, encodeMessage } from '../../src/shared/jsonrpc-framing'
import { LSP_SERVERS, type LspServerSpec } from '../../src/shared/lsp-registry'
import { createLspClient, type LspClient, type LspTransport } from '../../src/main/lsp-client'
import type { LspDiagnostic } from '../../src/shared/lsp-protocol'

/**
 * The LSP conversation, against a scripted server.
 *
 * A real server would make these tests slow, machine-dependent and unable to
 * produce the cases that matter — a reply that never comes, a server that exits
 * mid-request, one that sends a request of its own during startup. The
 * transport is injected for exactly that reason, the same way
 * `setLangWorkerFactory` makes the existing supervisors testable.
 */

const SPEC: LspServerSpec = LSP_SERVERS.find((server) => server.id === 'pyright') as LspServerSpec

interface FakeServer {
  readonly transport: LspTransport
  /** Everything the client has sent, decoded. */
  readonly sent: Record<string, unknown>[]
  /** The client's messages of one method. */
  sentOf(method: string): Record<string, unknown>[]
  /** The id of the client's first request of this method, or null. */
  idOf(method: string): number | null
  reply(id: number, result: unknown): void
  replyError(id: number, message: string): void
  notify(method: string, params: unknown): void
  requestFromServer(id: number, method: string): void
  stderr(text: string): void
  exit(code: number | null): void
  /** Whether the client resorted to killing the process. */
  wasKilled(): boolean
  /** Bytes, straight in — for framing-level cases. */
  raw(text: string): void
}

function fakeServer(): FakeServer {
  const sent: Record<string, unknown>[] = []
  const reader = createMessageReader()
  let onData: (chunk: Uint8Array) => void = () => {}
  let onStderr: (text: string) => void = () => {}
  const exitHandlers: ((code: number | null, signal: string | null) => void)[] = []
  let killed = false

  const deliver = (value: unknown): void => onData(encodeMessage(value))

  return {
    transport: {
      write(bytes) {
        for (const message of reader.push(bytes).messages) {
          sent.push(JSON.parse(message.body) as Record<string, unknown>)
        }
      },
      onData(handler) {
        onData = handler
      },
      onStderr(handler) {
        onStderr = handler
      },
      onExit(handler) {
        exitHandlers.push(handler)
      },
      kill() {
        killed = true
        for (const handler of exitHandlers) handler(null, 'SIGKILL')
      }
    },
    sent,
    sentOf: (method) => sent.filter((message) => message['method'] === method),
    idOf(method) {
      const found = sent.find((message) => message['method'] === method)
      return typeof found?.['id'] === 'number' ? found['id'] : null
    },
    reply: (id, result) => deliver({ jsonrpc: '2.0', id, result }),
    replyError: (id, message) => deliver({ jsonrpc: '2.0', id, error: { code: -32603, message } }),
    notify: (method, params) => deliver({ jsonrpc: '2.0', method, params }),
    requestFromServer: (id, method) => deliver({ jsonrpc: '2.0', id, method, params: {} }),
    stderr: (text) => onStderr(text),
    exit(code) {
      for (const handler of exitHandlers) handler(code, null)
    },
    raw: (text) => onData(new TextEncoder().encode(text)),
    wasKilled: () => killed
  }
}

interface Harness {
  readonly client: LspClient
  readonly server: FakeServer
  readonly notices: string[]
  readonly diagnostics: { uri: string; diagnostics: readonly LspDiagnostic[]; version: number | null }[]
  readonly exits: { code: number | null; signal: string | null }[]
  /** Answer `initialize` so the client leaves the handshake. */
  completeHandshake(): Promise<void>
}

function harness(root = '/w'): Harness {
  const server = fakeServer()
  const notices: string[] = []
  const diagnostics: Harness['diagnostics'] = []
  const exits: Harness['exits'] = []

  const client = createLspClient(SPEC, root, server.transport, {
    onDiagnostics: (uri, list, version) => diagnostics.push({ uri, diagnostics: list, version }),
    onNotice: (notice) => notices.push(notice),
    onExit: (code, signal) => exits.push({ code, signal })
  })

  return {
    client,
    server,
    notices,
    diagnostics,
    exits,
    async completeHandshake() {
      const id = server.idOf('initialize')
      expect(id, 'the client should have sent initialize').not.toBeNull()
      server.reply(id as number, { capabilities: {} })
      // One microtask turn for the awaited handshake to continue.
      await Promise.resolve()
      await Promise.resolve()
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the handshake', () => {
  it('sends initialize first, with the workspace root as a file URI', () => {
    const { server } = harness('/home/user/project')

    expect(server.sent[0]?.['method']).toBe('initialize')
    const params = server.sent[0]?.['params'] as Record<string, unknown>
    expect(params['rootUri']).toBe('file:///home/user/project')
  })

  it('sends initialized only after the server answers', async () => {
    const h = harness()
    expect(h.server.sentOf('initialized')).toHaveLength(0)

    await h.completeHandshake()
    expect(h.server.sentOf('initialized')).toHaveLength(1)
    expect(h.client.ready()).toBe(true)
  })

  it('queues documents opened during startup instead of sending or dropping them', async () => {
    /*
     * The common case, not an edge: the user already had a file open when the
     * server was spawned. Sending early is a protocol error some servers punish
     * by exiting; dropping means that file never gets diagnostics for the whole
     * session, and the editor looks fine while doing so.
     */
    const h = harness()
    h.client.openDocument('/w/a.py', 'python', 'x = 1', 1)
    expect(h.server.sentOf('textDocument/didOpen')).toHaveLength(0)

    await h.completeHandshake()

    const opened = h.server.sentOf('textDocument/didOpen')
    expect(opened).toHaveLength(1)
    // After `initialized`, never before.
    expect(h.server.sent.indexOf(opened[0] as Record<string, unknown>)).toBeGreaterThan(
      h.server.sent.findIndex((message) => message['method'] === 'initialized')
    )
  })

  it('proceeds when the server never answers initialize', async () => {
    // Some servers answer late and work afterwards. Refusing to continue would
    // make the session unrecoverable for a slow start.
    const h = harness()
    await vi.advanceTimersByTimeAsync(30_000)

    expect(h.notices.join(' ')).toContain('did not answer initialize')
    expect(h.client.ready()).toBe(true)
  })
})

describe('documents', () => {
  it('opens, changes and closes', async () => {
    const h = harness()
    await h.completeHandshake()

    h.client.openDocument('/w/a.py', 'python', 'x = 1', 1)
    h.client.changeDocument('/w/a.py', 'x = 2', 2)
    h.client.closeDocument('/w/a.py')

    expect(h.server.sentOf('textDocument/didOpen')).toHaveLength(1)
    expect(h.server.sentOf('textDocument/didChange')).toHaveLength(1)
    expect(h.server.sentOf('textDocument/didClose')).toHaveLength(1)
  })

  it('sends the whole document on a change', async () => {
    /*
     * Incremental sync would send less and would mean this client kept its own
     * copy of every buffer, in step with Monaco's edits — a second source of
     * truth for text, which is the bug class the TypeScript daemon's
     * `openDocument` already had once.
     */
    const h = harness()
    await h.completeHandshake()

    h.client.openDocument('/w/a.py', 'python', 'x = 1', 1)
    h.client.changeDocument('/w/a.py', 'x = 2', 2)

    const params = h.server.sentOf('textDocument/didChange')[0]?.['params'] as Record<string, unknown>
    expect(params['contentChanges']).toEqual([{ text: 'x = 2' }])
  })

  it('promotes a change on an unopened document to an open', async () => {
    // A didChange for a document the server was never told about is a protocol
    // error on most servers and a crash on some.
    const h = harness()
    await h.completeHandshake()

    h.client.changeDocument('/w/never-opened.py', 'x = 1', 3)

    expect(h.server.sentOf('textDocument/didOpen')).toHaveLength(1)
    expect(h.server.sentOf('textDocument/didChange')).toHaveLength(0)
  })

  it('ignores a close for a document that was never open', async () => {
    const h = harness()
    await h.completeHandshake()
    h.client.closeDocument('/w/a.py')
    expect(h.server.sentOf('textDocument/didClose')).toHaveLength(0)
  })
})

describe('diagnostics', () => {
  it('reports what the server publishes', async () => {
    const h = harness()
    await h.completeHandshake()

    h.server.notify('textDocument/publishDiagnostics', {
      uri: 'file:///w/a.py',
      version: 2,
      diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'bad' }]
    })

    expect(h.diagnostics).toHaveLength(1)
    expect(h.diagnostics[0]?.uri).toBe('file:///w/a.py')
    expect(h.diagnostics[0]?.version).toBe(2)
  })

  it('reports an empty set, because empty means "now clean"', async () => {
    // Skipping these is exactly how a fixed error keeps its squiggle forever —
    // the rule `fileDiagnosticsSchema` states and the clean sweep relies on.
    const h = harness()
    await h.completeHandshake()

    h.server.notify('textDocument/publishDiagnostics', { uri: 'file:///w/a.py', diagnostics: [] })

    expect(h.diagnostics).toHaveLength(1)
    expect(h.diagnostics[0]?.diagnostics).toEqual([])
  })

  it('ignores a malformed publish rather than throwing', async () => {
    const h = harness()
    await h.completeHandshake()

    h.server.notify('textDocument/publishDiagnostics', { diagnostics: [] })
    h.server.notify('textDocument/publishDiagnostics', { uri: 'file:///w/a.py', diagnostics: 'nope' })

    expect(h.diagnostics.map((entry) => entry.diagnostics)).toEqual([[]])
  })
})

describe('requests', () => {
  it('resolves a definition into a path and a one-based range', async () => {
    const h = harness()
    await h.completeHandshake()

    const promise = h.client.definition('/w/a.py', 5, 3)
    const id = h.server.idOf('textDocument/definition') as number
    h.server.reply(id, [
      { uri: 'file:///w/lib.py', range: { start: { line: 9, character: 4 }, end: { line: 9, character: 8 } } }
    ])

    expect(await promise).toEqual([
      { path: '/w/lib.py', range: { startLine: 10, startColumn: 5, endLine: 10, endColumn: 9 } }
    ])
  })

  it('accepts all three location shapes servers send', async () => {
    /*
     * `Location`, `Location[]` and `LocationLink[]` — the last with `targetUri`
     * and `targetSelectionRange`. Servers choose per capability and per
     * version, so handling one means go-to-definition silently does nothing
     * against the others.
     */
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }

    for (const result of [
      { uri: 'file:///w/lib.py', range },
      [{ uri: 'file:///w/lib.py', range }],
      [{ targetUri: 'file:///w/lib.py', targetSelectionRange: range }]
    ]) {
      const h = harness()
      await h.completeHandshake()
      const promise = h.client.definition('/w/a.py', 1, 1)
      h.server.reply(h.server.idOf('textDocument/definition') as number, result)
      expect(await promise).toEqual([
        { path: '/w/lib.py', range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 } }
      ])
    }
  })

  it('asks for references including the declaration', async () => {
    const h = harness()
    await h.completeHandshake()

    void h.client.references('/w/a.py', 1, 1)
    const params = h.server.sentOf('textDocument/references')[0]?.['params'] as Record<string, unknown>
    expect(params['context']).toEqual({ includeDeclaration: true })
  })

  it('flattens hover contents', async () => {
    const h = harness()
    await h.completeHandshake()

    const promise = h.client.hover('/w/a.py', 1, 1)
    h.server.reply(h.server.idOf('textDocument/hover') as number, {
      contents: { kind: 'markdown', value: '`int`' }
    })

    expect(await promise).toBe('`int`')
  })

  it('resolves empty on a timeout rather than rejecting', async () => {
    /*
     * A rejected provider is logged as an error in the user's console, and a
     * slow server is not the user's problem. Never returning at all would show
     * a spinner until the window closed.
     */
    const h = harness()
    await h.completeHandshake()

    const promise = h.client.definition('/w/a.py', 1, 1)
    await vi.advanceTimersByTimeAsync(3_000)

    expect(await promise).toEqual([])
    expect(h.notices.join(' ')).toContain('timed out')
  })

  it('resolves empty on a server error, and says so once', async () => {
    const h = harness()
    await h.completeHandshake()

    const promise = h.client.definition('/w/a.py', 1, 1)
    h.server.replyError(h.server.idOf('textDocument/definition') as number, 'no can do')

    expect(await promise).toEqual([])
    expect(h.notices.join(' ')).toContain('no can do')
  })

  it('settles everything in flight when the server dies', async () => {
    /*
     * The leak the TypeScript daemon's `scheduleRestart` had, found by writing
     * its crash test: a caller left waiting on a dead server holds its promise
     * until its own timeout, and every provider is stuck until then.
     */
    const h = harness()
    await h.completeHandshake()

    const promise = h.client.definition('/w/a.py', 1, 1)
    h.server.exit(1)

    expect(await promise).toEqual([])
    expect(h.exits).toEqual([{ code: 1, signal: null }])
    expect(h.client.ready()).toBe(false)
  })
})

describe('requests from the server', () => {
  it('answers client/registerCapability, which gopls waits for', async () => {
    /*
     * gopls and rust-analyzer both send this during startup. A server that
     * never gets its reply waits rather than proceeding, and the session looks
     * hung with nothing in any log.
     */
    const h = harness()
    await h.completeHandshake()

    h.server.requestFromServer(99, 'client/registerCapability')

    const reply = h.server.sent.find((message) => message['id'] === 99)
    expect(reply).toBeDefined()
    expect(reply?.['result']).toBeNull()
  })

  it('answers an unsupported request with MethodNotFound rather than silence', async () => {
    const h = harness()
    await h.completeHandshake()

    h.server.requestFromServer(100, 'workspace/applyEdit')

    const reply = h.server.sent.find((message) => message['id'] === 100)
    expect((reply?.['error'] as Record<string, unknown>)?.['code']).toBe(-32601)
  })
})

describe('noise on the wire', () => {
  it('survives a log line the server printed to stdout', async () => {
    const h = harness()
    await h.completeHandshake()

    h.server.raw('[warn] deprecated flag\n')
    h.server.notify('textDocument/publishDiagnostics', { uri: 'file:///w/a.py', diagnostics: [] })

    expect(h.diagnostics).toHaveLength(1)
  })

  it('reports stderr as a notice', async () => {
    const h = harness()
    await h.completeHandshake()
    h.server.stderr('  something went wrong  ')
    expect(h.notices.join(' ')).toContain('something went wrong')
  })

  it('ignores an empty stderr flush', async () => {
    const h = harness()
    await h.completeHandshake()
    h.server.stderr('   \n')
    expect(h.notices).toEqual([])
  })

  it('does not throw on a body that is not JSON', async () => {
    const h = harness()
    await h.completeHandshake()
    h.server.raw('Content-Length: 3\r\n\r\nnot')
    expect(h.notices.join(' ')).toContain('not JSON')
  })
})

describe('shutdown', () => {
  it('asks politely before killing', async () => {
    /*
     * A server killed mid-write can leave an index half-written, and
     * rust-analyzer's is expensive enough that the next session pays for it.
     */
    const h = harness()
    await h.completeHandshake()

    const stopping = h.client.stop()
    expect(h.server.sentOf('shutdown')).toHaveLength(1)
    expect(h.server.sentOf('exit')).toHaveLength(1)

    h.server.exit(0)
    await stopping
  })

  it('kills a server that will not leave', async () => {
    // Politeness has a deadline: a wedged server must not keep the app open.
    const h = harness()
    await h.completeHandshake()

    const stopping = h.client.stop()
    expect(h.server.wasKilled()).toBe(false)

    await vi.advanceTimersByTimeAsync(1_000)
    await stopping

    expect(h.server.wasKilled()).toBe(true)
    // A kill during our own shutdown is not a crash to report upwards.
    expect(h.exits).toEqual([])
  })

  it('does not kill a server that leaves on its own', async () => {
    const h = harness()
    await h.completeHandshake()

    const stopping = h.client.stop()
    h.server.exit(0)
    await stopping

    expect(h.server.wasKilled()).toBe(false)
  })

  it('sends nothing after stopping', async () => {
    const h = harness()
    await h.completeHandshake()

    const stopping = h.client.stop()
    h.server.exit(0)
    await stopping

    const before = h.server.sent.length
    h.client.openDocument('/w/a.py', 'python', 'x = 1', 1)
    expect(h.server.sent.length).toBe(before)
  })
})
