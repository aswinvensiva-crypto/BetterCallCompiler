import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMessageReader, encodeMessage } from '../../src/shared/jsonrpc-framing'
import type { LspServerSpec } from '../../src/shared/lsp-registry'
import type { LspTransport } from '../../src/main/lsp-client'
import {
  changeLspDocument,
  closeLspDocument,
  lspDefinition,
  lspStatus,
  openLspDocument,
  resetLspForTests,
  setLspEmitters,
  setLspTransportFactory,
  startLsp
} from '../../src/main/lsp-service'
import { resetDiagnosticStore, allDiagnostics } from '../../src/main/diagnostic-store'
import type { FileDiagnostics } from '../../src/shared/types'

/**
 * The supervisor: which servers run, when, and what happens when they die.
 *
 * The transport factory is injected, so no process is spawned and every server
 * in the registry can be driven regardless of what is installed on the machine
 * running the tests. That matters more here than it looks: a suite that only
 * passed where pyright happened to be installed would be green on one developer
 * machine and red on CI for a reason nobody could reproduce.
 */

const ROOT = '/w'

interface Spawned {
  readonly spec: LspServerSpec
  readonly sent: Record<string, unknown>[]
  sentOf(method: string): Record<string, unknown>[]
  completeHandshake(): Promise<void>
  publish(uri: string, diagnostics: unknown[]): void
  /** Any message, straight into the client's reader. */
  deliver(value: unknown): void
  /** The id of the client's first request of this method. */
  idOf(method: string): number
  exit(code: number): void
}

let spawned: Spawned[] = []
let notices: string[] = []
let emitted: FileDiagnostics[] = []

/** Every server is present, unless a test says otherwise. */
function installEverything(missing: readonly string[] = []): void {
  setLspTransportFactory((spec) => {
    if (missing.includes(spec.id)) return null as unknown as LspTransport

    const sent: Record<string, unknown>[] = []
    const reader = createMessageReader()
    let onData: (chunk: Uint8Array) => void = () => {}
    const exits: ((code: number | null, signal: string | null) => void)[] = []

    const record: Spawned = {
      spec,
      sent,
      sentOf: (method) => sent.filter((message) => message['method'] === method),
      async completeHandshake() {
        const found = sent.find((message) => message['method'] === 'initialize')
        onData(encodeMessage({ jsonrpc: '2.0', id: found?.['id'], result: { capabilities: {} } }))
        await Promise.resolve()
        await Promise.resolve()
      },
      publish(uri, diagnostics) {
        onData(
          encodeMessage({
            jsonrpc: '2.0',
            method: 'textDocument/publishDiagnostics',
            params: { uri, diagnostics }
          })
        )
      },
      deliver: (value) => onData(encodeMessage(value)),
      idOf(method) {
        const found = sent.find((message) => message['method'] === method)
        expect(found, `no ${method} was sent`).toBeDefined()
        return found?.['id'] as number
      },
      exit(code) {
        for (const handler of exits) handler(code, null)
      }
    }

    spawned.push(record)

    return {
      write(bytes) {
        for (const message of reader.push(bytes).messages) {
          sent.push(JSON.parse(message.body) as Record<string, unknown>)
        }
      },
      onData: (handler) => {
        onData = handler
      },
      onStderr: () => {},
      onExit: (handler) => exits.push(handler),
      kill: () => {
        for (const handler of exits) handler(null, 'SIGKILL')
      }
    }
  })
}

const lastSpawned = (): Spawned => spawned[spawned.length - 1] as Spawned

beforeEach(() => {
  vi.useFakeTimers()
  spawned = []
  notices = []
  emitted = []
  resetLspForTests()
  resetDiagnosticStore()
  setLspEmitters(
    (files) => emitted.push(...files),
    (notice) => notices.push(notice)
  )
  startLsp(ROOT)
})

afterEach(() => {
  resetLspForTests()
  resetDiagnosticStore()
  vi.useRealTimers()
})

describe('starting servers', () => {
  it('starts none until a document needs one', () => {
    /*
     * The cost model. rust-analyzer indexing a crate is minutes of CPU and a
     * gigabyte of memory; starting all four at boot would make this the slowest
     * thing on a machine whose workspace has no Rust in it.
     */
    installEverything()
    expect(spawned).toEqual([])
  })

  it('starts the one server the language needs', () => {
    installEverything()
    openLspDocument('/w/a.py', 'python', 'x = 1', 1)

    expect(spawned.map((server) => server.spec.id)).toEqual(['pyright'])
  })

  it('starts a second server only when a second language appears', () => {
    installEverything()
    openLspDocument('/w/a.py', 'python', 'x = 1', 1)
    openLspDocument('/w/b.py', 'python', 'y = 2', 1)
    expect(spawned).toHaveLength(1)

    openLspDocument('/w/main.go', 'go', 'package main', 1)
    expect(spawned.map((server) => server.spec.id)).toEqual(['pyright', 'gopls'])
  })

  it('leaves TypeScript and BCC to the daemons that have the real program', () => {
    /*
     * A second opinion arriving over LSP would duplicate every diagnostic and
     * make a clean F12 into a peek showing the same line twice — the exact
     * failure A3 avoided by turning Monaco's own providers off.
     */
    installEverything()
    openLspDocument('/w/a.ts', 'typescript', 'const x = 1', 1)
    openLspDocument('/w/a.bcc', 'bcc', 'let x = 1;', 1)

    expect(spawned).toEqual([])
  })

  it('says once that a server is missing, with how to get it', () => {
    installEverything(['pyright'])
    openLspDocument('/w/a.py', 'python', 'x = 1', 1)
    openLspDocument('/w/b.py', 'python', 'y = 2', 1)

    // Once, not once per file: a missing binary must not be a log per keystroke.
    const about = notices.filter((notice) => notice.includes('Pyright'))
    expect(about).toHaveLength(1)
    expect(about[0]).toContain('npm i -g pyright')
  })
})

describe('status', () => {
  it('lists every known server, installed or not', () => {
    // "We support Go, you do not have gopls" is the useful answer; an empty
    // list is not.
    installEverything()
    const status = lspStatus()

    expect(status.map((server) => server.id)).toEqual(['pyright', 'clangd', 'gopls', 'rust-analyzer'])
    expect(status.every((server) => typeof server.installed === 'boolean')).toBe(true)
  })

  it('reports ready only after the handshake', async () => {
    installEverything()
    openLspDocument('/w/a.py', 'python', 'x = 1', 1)

    const before = lspStatus().find((server) => server.id === 'pyright')
    expect(before?.ready).toBe(false)

    await lastSpawned().completeHandshake()
    expect(lspStatus().find((server) => server.id === 'pyright')?.ready).toBe(true)
  })
})

describe('diagnostics', () => {
  it('publishes into the store the Problems panel already reads', async () => {
    installEverything()
    openLspDocument('/w/src/a.py', 'python', 'x = 1', 1)
    await lastSpawned().completeHandshake()

    lastSpawned().publish('file:///w/src/a.py', [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        severity: 1,
        code: 'reportUndefinedVariable',
        message: '"foo" is not defined'
      }
    ])

    const stored = allDiagnostics()
    expect(stored).toHaveLength(1)
    expect(stored[0]?.relativePath).toBe('src/a.py')
    expect(stored[0]?.diagnostics[0]?.source).toBe('lsp')
    expect(stored[0]?.diagnostics[0]?.startLine).toBe(1)
    expect(emitted).toHaveLength(1)
  })

  it('drops a diagnostic for a file outside the workspace', async () => {
    /*
     * The renderer keys models on a workspace-relative path, so a diagnostic it
     * cannot place is worse than one it never saw — the same rule A3 applied to
     * definitions outside the root. Servers do report these: clangd on a system
     * header, pyright on a file in site-packages.
     */
    installEverything()
    openLspDocument('/w/a.py', 'python', 'x = 1', 1)
    await lastSpawned().completeHandshake()

    lastSpawned().publish('file:///usr/lib/python3/site-packages/x.py', [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'nope' }
    ])

    expect(allDiagnostics()).toEqual([])
    expect(emitted).toEqual([])
  })

  it('passes an empty set through, because empty means now clean', async () => {
    installEverything()
    openLspDocument('/w/a.py', 'python', 'x = 1', 1)
    await lastSpawned().completeHandshake()

    lastSpawned().publish('file:///w/a.py', [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'bad' }])
    lastSpawned().publish('file:///w/a.py', [])

    expect(allDiagnostics()[0]?.diagnostics).toEqual([])
  })
})

describe('when a server dies', () => {
  it('restarts it and replays the open buffers', async () => {
    /*
     * A restarted server that was never told about the open files reports
     * nothing until each is touched, which reads as the restart having silently
     * failed — the editor looks fine and the squiggles never come back.
     */
    installEverything()
    openLspDocument('/w/a.py', 'python', 'x = 1', 1)
    await lastSpawned().completeHandshake()
    expect(spawned).toHaveLength(1)

    lastSpawned().exit(1)
    await vi.advanceTimersByTimeAsync(500)

    expect(spawned).toHaveLength(2)
    await lastSpawned().completeHandshake()

    const opened = lastSpawned().sentOf('textDocument/didOpen')
    expect(opened).toHaveLength(1)
    const params = opened[0]?.['params'] as Record<string, unknown>
    expect((params['textDocument'] as Record<string, unknown>)['uri']).toBe('file:///w/a.py')
  })

  it('replays the LATEST text, not the text it was first opened with', async () => {
    installEverything()
    openLspDocument('/w/a.py', 'python', 'x = 1', 1)
    await lastSpawned().completeHandshake()
    changeLspDocument('/w/a.py', 'x = 99', 2)

    lastSpawned().exit(1)
    await vi.advanceTimersByTimeAsync(500)
    await lastSpawned().completeHandshake()

    const params = lastSpawned().sentOf('textDocument/didOpen')[0]?.['params'] as Record<string, unknown>
    expect((params['textDocument'] as Record<string, unknown>)['text']).toBe('x = 99')
  })

  it('gives up after three deaths in a minute and clears its squiggles', async () => {
    /*
     * Retrying forever turns a broken install into a fork bomb that presents as
     * the editor being slow. And a stale squiggle from a server that will never
     * run again is worse than none, because nothing will ever remove it.
     */
    installEverything()
    openLspDocument('/w/a.py', 'python', 'x = 1', 1)
    await lastSpawned().completeHandshake()

    lastSpawned().publish('file:///w/a.py', [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'bad' }
    ])
    expect(allDiagnostics()[0]?.diagnostics).toHaveLength(1)

    for (const backoff of [500, 2_000, 5_000]) {
      lastSpawned().exit(1)
      await vi.advanceTimersByTimeAsync(backoff)
    }
    lastSpawned().exit(1)
    await vi.advanceTimersByTimeAsync(10_000)

    expect(notices.join(' ')).toContain('will not be restarted')
    expect(allDiagnostics()[0]?.diagnostics).toEqual([])
    expect(lspStatus().find((server) => server.id === 'pyright')?.detail).toContain(
      'will not be restarted'
    )
  })
})

describe('documents', () => {
  it('forwards a change to the running server', async () => {
    installEverything()
    openLspDocument('/w/a.py', 'python', 'x = 1', 1)
    await lastSpawned().completeHandshake()

    changeLspDocument('/w/a.py', 'x = 2', 2)
    expect(lastSpawned().sentOf('textDocument/didChange')).toHaveLength(1)
  })

  it('ignores a change for a file nothing opened', async () => {
    installEverything()
    openLspDocument('/w/a.py', 'python', 'x = 1', 1)
    await lastSpawned().completeHandshake()

    changeLspDocument('/w/other.py', 'y = 1', 1)
    expect(lastSpawned().sentOf('textDocument/didChange')).toHaveLength(0)
  })

  it('closes, and then forgets the file on restart', async () => {
    installEverything()
    openLspDocument('/w/a.py', 'python', 'x = 1', 1)
    await lastSpawned().completeHandshake()
    closeLspDocument('/w/a.py')

    lastSpawned().exit(1)
    await vi.advanceTimersByTimeAsync(500)
    await lastSpawned().completeHandshake()

    expect(lastSpawned().sentOf('textDocument/didOpen')).toHaveLength(0)
  })
})

describe('queries', () => {
  it('returns nothing when no server handles the file', async () => {
    installEverything()
    expect(await lspDefinition('/w/a.txt', 1, 1)).toEqual([])
  })

  it('returns nothing when the server for the file is not running', async () => {
    // Never opened, so never started. A query must not spawn a server: the user
    // pressing F12 in a file the editor has not indexed should get nothing, not
    // a thirty-second pause.
    installEverything()
    expect(await lspDefinition('/w/a.py', 1, 1)).toEqual([])
    expect(spawned).toEqual([])
  })

  it('resolves a definition to a workspace-relative path', async () => {
    installEverything()
    openLspDocument('/w/a.py', 'python', 'x = 1', 1)
    await lastSpawned().completeHandshake()

    const promise = lspDefinition('/w/a.py', 5, 3)
    lastSpawned().deliver({
      jsonrpc: '2.0',
      id: lastSpawned().idOf('textDocument/definition'),
      result: [
        {
          uri: 'file:///w/lib/helper.py',
          range: { start: { line: 9, character: 4 }, end: { line: 9, character: 10 } }
        }
      ]
    })

    expect(await promise).toEqual([
      {
        path: '/w/lib/helper.py',
        relativePath: 'lib/helper.py',
        range: { startLine: 10, startColumn: 5, endLine: 10, endColumn: 11 }
      }
    ])
  })

  it('drops a definition that lands outside the workspace', async () => {
    // Following a symbol into site-packages or a system header is common and
    // the renderer cannot open what it cannot place.
    installEverything()
    openLspDocument('/w/a.py', 'python', 'x = 1', 1)
    await lastSpawned().completeHandshake()

    const promise = lspDefinition('/w/a.py', 5, 3)
    lastSpawned().deliver({
      jsonrpc: '2.0',
      id: lastSpawned().idOf('textDocument/definition'),
      result: [
        {
          uri: 'file:///usr/lib/python3/typing.py',
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } }
        }
      ]
    })

    expect(await promise).toEqual([])
  })
})
