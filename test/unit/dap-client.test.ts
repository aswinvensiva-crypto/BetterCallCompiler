import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMessageReader, encodeMessage } from '../../src/shared/jsonrpc-framing'
import { createDapClient, type DapClient, type DapTransport } from '../../src/main/dap-client'

/**
 * The debug session.
 *
 * Most of this file is about the launch sequence, because that is where DAP
 * integrations actually fail and because the failure has no good symptom: the
 * debugger starts and immediately exits, with nothing in any log. The awkward
 * part is that `initialize` has a RESPONSE and there is also an `initialized`
 * EVENT, they are different messages, and adapters disagree about which comes
 * first. Both orderings are tested.
 */

interface FakeAdapter {
  readonly transport: DapTransport
  readonly sent: Record<string, unknown>[]
  sentOf(command: string): Record<string, unknown>[]
  seqOf(command: string): number
  respond(command: string, body: unknown, success?: boolean): void
  failed(command: string, message: string): void
  event(name: string, body?: unknown): void
  requestFromAdapter(seq: number, command: string): void
  exit(code: number | null): void
  wasKilled(): boolean
}

function fakeAdapter(): FakeAdapter {
  const sent: Record<string, unknown>[] = []
  const reader = createMessageReader()
  let onData: (chunk: Uint8Array) => void = () => {}
  const exits: ((code: number | null) => void)[] = []
  let killed = false
  let outgoing = 1000

  const deliver = (value: unknown): void => onData(encodeMessage(value))

  const seqOf = (command: string): number => {
    const found = sent.find((message) => message['command'] === command)
    expect(found, `no ${command} request was sent`).toBeDefined()
    return found?.['seq'] as number
  }

  return {
    transport: {
      write(bytes) {
        for (const message of reader.push(bytes).messages) {
          sent.push(JSON.parse(message.body) as Record<string, unknown>)
        }
      },
      onData: (handler) => {
        onData = handler
      },
      onExit: (handler) => exits.push(handler),
      kill() {
        killed = true
      }
    },
    sent,
    sentOf: (command) =>
      sent.filter((message) => message['command'] === command && message['type'] === 'request'),
    seqOf,
    respond(command, body, success = true) {
      deliver({
        seq: outgoing++,
        type: 'response',
        request_seq: seqOf(command),
        success,
        command,
        body
      })
    },
    failed(command, message) {
      deliver({
        seq: outgoing++,
        type: 'response',
        request_seq: seqOf(command),
        success: false,
        command,
        message
      })
    },
    event: (name, body) => deliver({ seq: outgoing++, type: 'event', event: name, body }),
    requestFromAdapter: (seq, command) => deliver({ seq, type: 'request', command, arguments: {} }),
    exit(code) {
      for (const handler of exits) handler(code)
    },
    wasKilled: () => killed
  }
}

interface Harness {
  readonly client: DapClient
  readonly adapter: FakeAdapter
  readonly stopped: { reason: string; threadId: number | null; description: string | null }[]
  readonly output: { category: string; text: string }[]
  readonly notices: string[]
  readonly terminated: number[]
  readonly exits: (number | null)[]
  readonly continued: number[]
}

function harness(): Harness {
  const adapter = fakeAdapter()
  const stopped: Harness['stopped'] = []
  const output: Harness['output'] = []
  const notices: string[] = []
  const terminated: number[] = []
  const exits: (number | null)[] = []
  const continued: number[] = []

  const client = createDapClient(adapter.transport, {
    onStopped: (reason, threadId, description) => stopped.push({ reason, threadId, description }),
    onContinued: () => continued.push(1),
    onOutput: (category, text) => output.push({ category, text }),
    onTerminated: () => terminated.push(1),
    onExit: (code) => exits.push(code),
    onNotice: (notice) => notices.push(notice)
  })

  return { client, adapter, stopped, output, notices, terminated, exits, continued }
}

/** Drive a full launch, with the adapter answering in the given order. */
async function launch(h: Harness, order: 'response-first' | 'event-first'): Promise<void> {
  const starting = h.client.start({ request: 'launch', program: '/w/a.py' }, 'debugpy')

  if (order === 'response-first') {
    h.adapter.respond('initialize', { supportsConfigurationDoneRequest: true })
    h.adapter.event('initialized')
  } else {
    h.adapter.event('initialized')
    h.adapter.respond('initialize', { supportsConfigurationDoneRequest: true })
  }

  await vi.advanceTimersByTimeAsync(0)
  h.adapter.respond('configurationDone', {})
  await starting
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the launch sequence', () => {
  it('sends initialize first', () => {
    const h = harness()
    void h.client.start({ request: 'launch' }, 'debugpy')

    expect(h.adapter.sent[0]?.['command']).toBe('initialize')
    const args = h.adapter.sent[0]?.['arguments'] as Record<string, unknown>
    // One-based, so every position agrees with sourceRangeSchema and Monaco
    // with no conversion at all — the opposite of the LSP boundary.
    expect(args['linesStartAt1']).toBe(true)
    expect(args['columnsStartAt1']).toBe(true)
  })

  it('waits for the initialized EVENT as well as the response', async () => {
    /*
     * They are different messages. Treating the event as the response
     * deadlocks; waiting only for the response races. This asserts the response
     * alone is not enough.
     */
    const h = harness()
    let done = false
    void h.client.start({ request: 'launch' }, 'debugpy').then(() => {
      done = true
    })

    h.adapter.respond('initialize', { supportsConfigurationDoneRequest: false })
    await vi.advanceTimersByTimeAsync(10)
    expect(done).toBe(false)

    h.adapter.event('initialized')
    await vi.advanceTimersByTimeAsync(10)
    expect(done).toBe(true)
  })

  it('works when the event arrives BEFORE the response', async () => {
    // Real adapters do this. A client that assumed the response came first
    // would hang here forever.
    const h = harness()
    await launch(h, 'event-first')
    expect(h.adapter.sentOf('launch')).toHaveLength(1)
  })

  it('works when the response arrives before the event', async () => {
    const h = harness()
    await launch(h, 'response-first')
    expect(h.adapter.sentOf('launch')).toHaveLength(1)
  })

  it('sends configurationDone only when the adapter supports it', async () => {
    // Asking for something the adapter did not advertise ends the session in
    // an error dialogue mid-launch.
    const h = harness()
    const starting = h.client.start({ request: 'launch' }, 'debugpy')
    h.adapter.respond('initialize', { supportsConfigurationDoneRequest: false })
    h.adapter.event('initialized')
    await starting

    expect(h.adapter.sentOf('configurationDone')).toHaveLength(0)
    expect(h.adapter.sentOf('launch')).toHaveLength(1)
  })

  it('does not wait for launch to be answered', async () => {
    /*
     * Several adapters do not answer `launch` until the program stops or
     * exits. Awaiting it before returning would hang the session at startup,
     * and the failure looks like the debugger never starting.
     */
    const h = harness()
    await launch(h, 'response-first')

    // `start` resolved and `launch` is still unanswered.
    expect(h.adapter.sentOf('launch')).toHaveLength(1)
    expect(h.client.capabilities().supportsConfigurationDoneRequest).toBe(true)
  })

  it('sends attach rather than launch when the config says so', async () => {
    const h = harness()
    const starting = h.client.start({ request: 'attach', port: 5678 }, 'debugpy')
    h.adapter.respond('initialize', {})
    h.adapter.event('initialized')
    await starting

    expect(h.adapter.sentOf('attach')).toHaveLength(1)
    expect(h.adapter.sentOf('launch')).toHaveLength(0)
  })

  it('records what the adapter said it can do', async () => {
    const h = harness()
    const starting = h.client.start({ request: 'launch' }, 'debugpy')
    h.adapter.respond('initialize', { supportsStepBack: true, supportsTerminateRequest: true })
    h.adapter.event('initialized')
    await starting

    // `supportsStepBack` is the one the BCC plan's time-travel amendment needs
    // to ask about, and a UI that offered it unconditionally would fail
    // mid-session against every adapter that cannot.
    expect(h.client.capabilities().supportsStepBack).toBe(true)
    expect(h.client.capabilities().supportsRestartRequest).toBeUndefined()
  })
})

describe('breakpoints', () => {
  it('sends them and reports what the adapter verified', async () => {
    const h = harness()
    await launch(h, 'response-first')

    const promise = h.client.setBreakpoints('/w/a.py', [{ line: 10 }, { line: 11 }])
    h.adapter.respond('setBreakpoints', {
      breakpoints: [
        { id: 1, verified: true, line: 10 },
        { id: 2, verified: false, line: 12, message: 'moved to the next statement' }
      ]
    })

    expect(await promise).toEqual([
      { id: 1, verified: true, line: 10, message: undefined },
      { id: 2, verified: false, line: 12, message: 'moved to the next statement' }
    ])
  })

  it('treats a missing verified flag as NOT verified', async () => {
    /*
     * Defaulting the other way shows a solid red dot for a breakpoint the
     * adapter never set — the single most common way a debugger UI lies, and
     * the user then watches execution run straight past it.
     */
    const h = harness()
    await launch(h, 'response-first')

    const promise = h.client.setBreakpoints('/w/a.py', [{ line: 10 }])
    h.adapter.respond('setBreakpoints', { breakpoints: [{ line: 10 }] })

    expect((await promise)[0]?.verified).toBe(false)
  })

  it('carries a condition through', async () => {
    const h = harness()
    await launch(h, 'response-first')

    void h.client.setBreakpoints('/w/a.py', [{ line: 10, condition: 'i > 5' }])
    const args = h.adapter.sentOf('setBreakpoints')[0]?.['arguments'] as Record<string, unknown>
    expect(args['breakpoints']).toEqual([{ line: 10, condition: 'i > 5' }])
  })
})

describe('stopping and inspecting', () => {
  it('reports a stop with its reason and thread', async () => {
    const h = harness()
    await launch(h, 'response-first')

    h.adapter.event('stopped', { reason: 'breakpoint', threadId: 1, allThreadsStopped: true })
    expect(h.stopped).toEqual([{ reason: 'breakpoint', threadId: 1, description: null }])
  })

  it('walks threads, stack, scopes and variables', async () => {
    const h = harness()
    await launch(h, 'response-first')

    const threads = h.client.threads()
    h.adapter.respond('threads', { threads: [{ id: 1, name: 'MainThread' }] })
    expect(await threads).toEqual([{ id: 1, name: 'MainThread' }])

    const stack = h.client.stackTrace(1)
    h.adapter.respond('stackTrace', {
      stackFrames: [{ id: 7, name: 'main', line: 10, column: 1, source: { path: '/w/a.py' } }]
    })
    expect(await stack).toEqual([
      { id: 7, name: 'main', line: 10, column: 1, source: { name: undefined, path: '/w/a.py' } }
    ])

    const scopes = h.client.scopes(7)
    h.adapter.respond('scopes', {
      scopes: [{ name: 'Locals', variablesReference: 100 }, { name: 'Globals', variablesReference: 101, expensive: true }]
    })
    expect(await scopes).toEqual([
      { name: 'Locals', variablesReference: 100, expensive: false },
      { name: 'Globals', variablesReference: 101, expensive: true }
    ])

    const variables = h.client.variables(100)
    h.adapter.respond('variables', {
      variables: [{ name: 'i', value: '3', type: 'int', variablesReference: 0 }]
    })
    expect(await variables).toEqual([
      { name: 'i', value: '3', type: 'int', variablesReference: 0 }
    ])
  })

  it('coerces a variable value the adapter sent as a number', async () => {
    // The spec says string. An adapter sending a number would otherwise show
    // as "undefined" in the variables pane.
    const h = harness()
    await launch(h, 'response-first')

    const variables = h.client.variables(100)
    h.adapter.respond('variables', { variables: [{ name: 'i', value: 3, variablesReference: 0 }] })
    expect((await variables)[0]?.value).toBe('3')
  })

  it('keeps a frame with no line rather than renumbering the stack', async () => {
    const h = harness()
    await launch(h, 'response-first')

    const stack = h.client.stackTrace(1)
    h.adapter.respond('stackTrace', { stackFrames: [{ id: 1, name: '<native>' }, { id: 2, name: 'main', line: 4, column: 1 }] })

    expect((await stack).map((frame) => frame.id)).toEqual([1, 2])
  })
})

describe('stepping', () => {
  it.each([
    ['continue_', 'continue'],
    ['next', 'next'],
    ['stepIn', 'stepIn'],
    ['stepOut', 'stepOut'],
    ['stepBack', 'stepBack'],
    ['pause', 'pause']
  ] as const)('%s sends %s', async (method, command) => {
    const h = harness()
    await launch(h, 'response-first')

    void (h.client[method] as (threadId: number) => Promise<void>)(1)
    expect(h.adapter.sentOf(command)).toHaveLength(1)
    expect((h.adapter.sentOf(command)[0]?.['arguments'] as Record<string, unknown>)['threadId']).toBe(1)
  })

  it('reports a resume so the UI can clear its stack', async () => {
    const h = harness()
    await launch(h, 'response-first')
    h.adapter.event('continued', { threadId: 1 })
    expect(h.continued).toHaveLength(1)
  })

  it('turns a failed step into a notice rather than an error', async () => {
    // Stepping a thread that just exited is normal, not exceptional.
    const h = harness()
    await launch(h, 'response-first')

    const promise = h.client.next(1)
    h.adapter.failed('next', 'thread is gone')
    await promise

    expect(h.notices.join(' ')).toContain('thread is gone')
  })
})

describe('output and termination', () => {
  it('forwards program output with its category', async () => {
    const h = harness()
    await launch(h, 'response-first')

    h.adapter.event('output', { category: 'stdout', output: 'hello\n' })
    h.adapter.event('output', { category: 'stderr', output: 'oops\n' })

    expect(h.output).toEqual([
      { category: 'stdout', text: 'hello\n' },
      { category: 'stderr', text: 'oops\n' }
    ])
  })

  it('defaults an uncategorised output to console', async () => {
    const h = harness()
    await launch(h, 'response-first')
    h.adapter.event('output', { output: 'plain' })
    expect(h.output).toEqual([{ category: 'console', text: 'plain' }])
  })

  it('reports termination and adapter exit as different things', async () => {
    /*
     * They are: a debuggee can end while the adapter stays up for a restart,
     * and an adapter can crash while the debuggee is still running.
     */
    const h = harness()
    await launch(h, 'response-first')

    h.adapter.event('terminated')
    expect(h.terminated).toHaveLength(1)
    expect(h.exits).toHaveLength(0)

    h.adapter.exit(0)
    expect(h.exits).toEqual([0])
  })

  it('ignores events it does not use', async () => {
    // Adapters send `thread`, `module`, `loadedSource`, `progressStart`. A
    // notice each would bury the ones that matter.
    const h = harness()
    await launch(h, 'response-first')

    h.adapter.event('module', { module: {} })
    h.adapter.event('progressStart', {})

    expect(h.notices).toEqual([])
  })
})

describe('robustness', () => {
  it('answers an adapter-initiated request instead of hanging', async () => {
    /*
     * `runInTerminal` is the one adapters commonly send, and this client says
     * it does not support it — so a failure is the honest reply. Silence would
     * leave the adapter waiting and the session hangs at launch.
     */
    const h = harness()
    await launch(h, 'response-first')

    h.adapter.requestFromAdapter(555, 'runInTerminal')

    const reply = h.adapter.sent.find(
      (message) => message['type'] === 'response' && message['request_seq'] === 555
    )
    expect(reply?.['success']).toBe(false)
  })

  it('settles everything in flight when the adapter dies', async () => {
    const h = harness()
    await launch(h, 'response-first')

    const promise = h.client.threads()
    h.adapter.exit(1)

    expect(await promise).toEqual([])
    expect(h.exits).toEqual([1])
  })

  it('resolves empty on a timeout rather than hanging the UI', async () => {
    const h = harness()
    await launch(h, 'response-first')

    const promise = h.client.threads()
    await vi.advanceTimersByTimeAsync(5_000)

    expect(await promise).toEqual([])
    expect(h.notices.join(' ')).toContain('timed out')
  })

  it('survives a malformed body', async () => {
    const h = harness()
    await launch(h, 'response-first')

    const promise = h.client.variables(1)
    h.adapter.respond('variables', { variables: 'not an array' })
    expect(await promise).toEqual([])
  })
})

describe('disconnect', () => {
  it('prefers terminate where the adapter supports it', async () => {
    /*
     * `terminate` asks the debuggee to stop; `disconnect` merely detaches.
     * Preferring terminate is what stops a session leaving a process running
     * with a breakpoint still set in it.
     */
    const h = harness()
    const starting = h.client.start({ request: 'launch' }, 'debugpy')
    h.adapter.respond('initialize', { supportsTerminateRequest: true })
    h.adapter.event('initialized')
    await starting

    const stopping = h.client.disconnect()
    h.adapter.respond('terminate', {})
    await vi.advanceTimersByTimeAsync(0)
    h.adapter.respond('disconnect', {})
    await stopping

    expect(h.adapter.sentOf('terminate')).toHaveLength(1)
    expect(h.adapter.wasKilled()).toBe(true)
  })

  it('disconnects without terminate when the adapter cannot', async () => {
    const h = harness()
    await launch(h, 'response-first')

    const stopping = h.client.disconnect()
    h.adapter.respond('disconnect', {})
    await stopping

    expect(h.adapter.sentOf('terminate')).toHaveLength(0)
    expect(h.adapter.sentOf('disconnect')).toHaveLength(1)
  })

  it('sends nothing after disconnecting', async () => {
    const h = harness()
    await launch(h, 'response-first')

    const stopping = h.client.disconnect()
    h.adapter.respond('disconnect', {})
    await stopping

    const before = h.adapter.sent.length
    await h.client.threads()
    expect(h.adapter.sent.length).toBe(before)
  })
})
