import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMessageReader, encodeMessage } from '../../src/shared/jsonrpc-framing'
import type { DapAdapterSpec } from '../../src/shared/dap-registry'
import {
  dapAdapters,
  dapContinue,
  dapEvaluate,
  dapPause,
  dapScopes,
  dapStackTrace,
  dapStepIn,
  dapStepOut,
  dapStepOver,
  dapThreads,
  dapVariables,
  resetDapForTests,
  setDapBreakpoints,
  setDapCommandProbe,
  setDapEmitters,
  setDapTransportFactory,
  startDap,
  startDapSession,
  stopDap
} from '../../src/main/dap-service'
import type { DapOutputRecord, DapSessionStatusRecord } from '../../src/shared/types'

/**
 * The DAP supervisor: one active session, breakpoints that outlive it, and
 * what the controls and queries do with and without one running.
 *
 * The transport factory and the command probe are both injected, for the same
 * reason `lsp-service.test.ts` injects them: a suite that only passes where
 * `python3` or `gdb` happens to be on PATH is green on one machine and red on
 * CI for a reason nobody can reproduce.
 */

const ROOT = '/w'

interface FakeAdapter {
  readonly spec: DapAdapterSpec
  readonly sent: Record<string, unknown>[]
  sentOf(command: string): Record<string, unknown>[]
  respond(command: string, body: unknown, success?: boolean): void
  event(name: string, body?: unknown): void
  exit(code: number | null): void
}

let spawned: FakeAdapter[] = []
let statuses: (DapSessionStatusRecord | null)[] = []
let output: DapOutputRecord[] = []
let notices: string[] = []

/** Every adapter's command resolves, and its transport is scripted, unless named in `missing`. */
function installEverything(missing: readonly string[] = []): void {
  setDapCommandProbe((command) => (missing.includes(command) ? null : `/usr/bin/${command}`))
  setDapTransportFactory((spec) => {
    if (missing.includes(spec.id)) return null

    const sent: Record<string, unknown>[] = []
    const reader = createMessageReader()
    let onData: (chunk: Uint8Array) => void = () => {}
    const exits: ((code: number | null) => void)[] = []
    let outgoing = 1000
    /** So responding to the same command twice answers two DIFFERENT requests. */
    const answered = new Set<number>()

    const deliver = (value: unknown): void => onData(encodeMessage(value))
    const seqOf = (command: string): number => {
      const found = sent.find(
        (message) =>
          message['command'] === command &&
          message['type'] === 'request' &&
          !answered.has(message['seq'] as number)
      )
      expect(found, `no unanswered ${command} request was sent`).toBeDefined()
      return found?.['seq'] as number
    }

    const record: FakeAdapter = {
      spec,
      sent,
      sentOf: (command) =>
        sent.filter((message) => message['command'] === command && message['type'] === 'request'),
      respond(command, body, success = true) {
        const seq = seqOf(command)
        answered.add(seq)
        deliver({ seq: outgoing++, type: 'response', request_seq: seq, success, command, body })
      },
      event: (name, body) => deliver({ seq: outgoing++, type: 'event', event: name, body }),
      exit(code) {
        for (const handler of exits) handler(code)
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
      onExit: (handler) => exits.push(handler),
      kill: () => {}
    }
  })
}

const lastSpawned = (): FakeAdapter => spawned[spawned.length - 1] as FakeAdapter

/**
 * Drives a session past `initialize` / `initialized` / `configurationDone`,
 * mirroring `dap-client.test.ts`'s own `launch` helper — the ordering here is
 * exactly what `dap-client.ts` requires and is not this file's to re-test.
 */
async function completeHandshake(adapter: FakeAdapter): Promise<void> {
  adapter.respond('initialize', { supportsConfigurationDoneRequest: true })
  adapter.event('initialized')
  await vi.advanceTimersByTimeAsync(0)
  adapter.respond('configurationDone', {})
  await vi.advanceTimersByTimeAsync(0)
}

/**
 * Starts a python session (no breakpoints pending) and drives it to `running`.
 *
 * 1000ms rather than 0: replacing an already-running session means
 * `startDapSession` first awaits the old one's `disconnect`, which — since
 * this adapter never claimed `supportsTerminateRequest` — times out after
 * `DISCONNECT_GRACE_MS` rather than resolving from a reply. Advancing that far
 * up front is a no-op for a *first* session, where nothing is pending yet.
 */
async function startPythonSession(relativePath = 'a.py'): Promise<DapSessionStatusRecord> {
  const promise = startDapSession(relativePath, `${ROOT}/${relativePath}`, 'python')
  await vi.advanceTimersByTimeAsync(1_000)
  await completeHandshake(lastSpawned())
  return promise
}

beforeEach(() => {
  vi.useFakeTimers()
  spawned = []
  statuses = []
  output = []
  notices = []
  resetDapForTests()
  setDapEmitters(
    (status) => statuses.push(status),
    (payload) => output.push(payload),
    (notice) => notices.push(notice)
  )
  startDap(ROOT)
})

afterEach(() => {
  resetDapForTests()
  vi.useRealTimers()
})

describe('adapter status', () => {
  it('lists every registered adapter', () => {
    installEverything()
    const adapters = dapAdapters()
    expect(adapters.map((adapter) => adapter.id)).toEqual(['debugpy', 'gdb'])
  })

  it('reports installed from the probe', () => {
    installEverything(['gdb'])
    const adapters = dapAdapters()
    expect(adapters.find((adapter) => adapter.id === 'debugpy')?.installed).toBe(true)
    expect(adapters.find((adapter) => adapter.id === 'gdb')?.installed).toBe(false)
  })
})

describe('breakpoints outlive any session', () => {
  it('answers unverified when nothing is running', async () => {
    installEverything()
    const result = await setDapBreakpoints(`${ROOT}/a.py`, [3, 7])
    expect(result).toEqual([
      { line: 3, verified: false, message: null },
      { line: 7, verified: false, message: null }
    ])
  })

  it('applies immediately to an active session', async () => {
    installEverything()
    await startPythonSession()

    const pending = setDapBreakpoints(`${ROOT}/a.py`, [3])
    lastSpawned().respond('setBreakpoints', { breakpoints: [{ line: 3, verified: true }] })
    expect(await pending).toEqual([{ line: 3, verified: true, message: null }])
  })

  it('is replayed onto every new session, for every file that has any', async () => {
    installEverything()
    await setDapBreakpoints(`${ROOT}/a.py`, [3])
    await setDapBreakpoints(`${ROOT}/lib/b.py`, [10])

    // Not the `startPythonSession` helper: it awaits the session to `running`,
    // which here would mean awaiting the replay's own `setBreakpoints` calls —
    // so those are answered in between, before the session promise settles.
    const promise = startDapSession('a.py', `${ROOT}/a.py`, 'python')
    await vi.advanceTimersByTimeAsync(0)
    await completeHandshake(lastSpawned())
    lastSpawned().respond('setBreakpoints', { breakpoints: [] })
    lastSpawned().respond('setBreakpoints', { breakpoints: [] })
    await promise

    const requests = lastSpawned().sentOf('setBreakpoints')
    const paths = requests.map(
      (request) => ((request['arguments'] as Record<string, unknown>)['source'] as Record<string, unknown>)['path']
    )
    expect(paths.sort()).toEqual([`${ROOT}/a.py`, `${ROOT}/lib/b.py`].sort())
  })

  it('clearing a file removes it from what gets replayed', async () => {
    installEverything()
    await setDapBreakpoints(`${ROOT}/a.py`, [3])
    await setDapBreakpoints(`${ROOT}/a.py`, [])

    await startPythonSession()
    const requests = lastSpawned().sentOf('setBreakpoints')
    expect(requests).toEqual([])
  })
})

describe('starting a session', () => {
  it('fails with no adapter registered for the language', async () => {
    installEverything()
    await expect(startDapSession('a.rb', `${ROOT}/a.rb`, 'ruby')).rejects.toMatchObject({
      code: 'UNSUPPORTED'
    })
  })

  it('fails with the install hint when the command is not on PATH', async () => {
    installEverything(['python3', 'python'])
    await expect(startDapSession('a.py', `${ROOT}/a.py`, 'python')).rejects.toMatchObject({
      code: 'UNSUPPORTED',
      message: expect.stringContaining('pip install debugpy')
    })
  })

  it('fails for C without gcc on PATH, without spawning anything', async () => {
    // The command probe alone decides this — `resolved === null` is checked
    // before any process is spawned, so there is nothing here for a real
    // compiler to do even in an environment that has none.
    installEverything(['gcc'])
    await expect(startDapSession('a.c', `${ROOT}/a.c`, 'c')).rejects.toMatchObject({
      code: 'UNSUPPORTED',
      message: expect.stringContaining('gcc is not on your PATH')
    })
  })

  it('reaches running and reports it on the status stream', async () => {
    installEverything()
    const session = await startPythonSession('a.py')

    expect(session.state).toBe('running')
    expect(session.adapterId).toBe('debugpy')
    expect(session.relativePath).toBe('a.py')
    expect(statuses.at(-1)).toEqual(session)
  })

  it('ends whatever session was already running', async () => {
    installEverything()
    await startPythonSession('a.py')
    const first = lastSpawned()

    await startPythonSession('b.py')

    // `disconnect` prefers `terminate` when the adapter has not said it
    // supports it, so the first session's teardown is a plain disconnect.
    expect(first.sentOf('disconnect')).toHaveLength(1)
    expect(spawned).toHaveLength(2)
  })
})

describe('events from a running session', () => {
  it('moves to stopped with the reason and thread', async () => {
    installEverything()
    await startPythonSession()
    statuses.length = 0

    lastSpawned().event('stopped', { reason: 'breakpoint', threadId: 1 })

    const latest = statuses.at(-1)
    expect(latest?.state).toBe('stopped')
    expect(latest?.stoppedReason).toBe('breakpoint')
    expect(latest?.threadId).toBe(1)
  })

  it('moves back to running on continued', async () => {
    installEverything()
    await startPythonSession()
    lastSpawned().event('stopped', { reason: 'breakpoint', threadId: 1 })

    lastSpawned().event('continued')
    expect(statuses.at(-1)?.state).toBe('running')
    expect(statuses.at(-1)?.threadId).toBeNull()
  })

  it('forwards output', async () => {
    installEverything()
    await startPythonSession()

    lastSpawned().event('output', { category: 'stdout', output: 'hello\n' })
    expect(output).toEqual([{ sessionId: expect.any(String), category: 'stdout', text: 'hello\n' }])
  })

  it('reports terminated, then clears the session', async () => {
    installEverything()
    await startPythonSession()

    lastSpawned().event('terminated')
    expect(statuses.at(-1)?.state).toBe('terminated')

    // The session is gone: a query answers empty rather than reaching a dead client.
    expect(await dapThreads()).toEqual([])
  })

  it('clears to null when the adapter process itself exits', async () => {
    installEverything()
    await startPythonSession()

    lastSpawned().exit(1)
    expect(statuses.at(-1)).toBeNull()
  })
})

describe('controls', () => {
  it('do nothing without a session', async () => {
    installEverything()
    await dapContinue()
    await dapStepOver()
    await dapStepIn()
    await dapStepOut()
    await dapPause()
    expect(spawned).toEqual([])
  })

  it('do nothing while running but not stopped on a thread', async () => {
    installEverything()
    await startPythonSession()
    await dapContinue()
    expect(lastSpawned().sentOf('continue')).toEqual([])
  })

  it('target the thread the session is stopped on', async () => {
    installEverything()
    await startPythonSession()
    lastSpawned().event('stopped', { reason: 'breakpoint', threadId: 7 })

    const pending = dapStepOver()
    lastSpawned().respond('next', {})
    await pending

    const sent = lastSpawned().sentOf('next')[0]
    expect((sent?.['arguments'] as Record<string, unknown>)['threadId']).toBe(7)
  })
})

describe('queries', () => {
  it('answer empty or null without a session', async () => {
    installEverything()
    expect(await dapThreads()).toEqual([])
    expect(await dapStackTrace(1)).toEqual([])
    expect(await dapScopes(1)).toEqual([])
    expect(await dapVariables(1)).toEqual([])
    expect(await dapEvaluate('x', null)).toBeNull()
  })

  it('maps a stack frame, dropping the adapter-specific parts', async () => {
    installEverything()
    await startPythonSession()
    lastSpawned().event('stopped', { reason: 'breakpoint', threadId: 1 })

    const pending = dapStackTrace(1)
    lastSpawned().respond('stackTrace', {
      stackFrames: [{ id: 5, name: 'main', line: 3, column: 1, source: { path: `${ROOT}/a.py` } }]
    })

    expect(await pending).toEqual([{ id: 5, name: 'main', path: `${ROOT}/a.py`, line: 3, column: 1 }])
  })
})

describe('stopping', () => {
  it('disconnects the adapter and reports no session', async () => {
    installEverything()
    await startPythonSession()

    const pending = stopDap()
    // `disconnect` was never told the adapter supports `terminate`, so it goes
    // straight to a plain `disconnect` request, which times out rather than
    // getting a reply here — `stopDap` resolves either way.
    await vi.advanceTimersByTimeAsync(1_000)
    await pending

    expect(statuses.at(-1)).toBeNull()
    expect(lastSpawned().sentOf('disconnect')).toHaveLength(1)
  })

  it('is a no-op with nothing running', async () => {
    installEverything()
    await stopDap()
    expect(spawned).toEqual([])
  })
})
