import { createMessageReader, encodeMessage } from '../shared/jsonrpc-framing'
import {
  classifyDapMessage,
  initializeArguments,
  readBreakpoints,
  readCapabilities,
  readOutput,
  readScopes,
  readStackFrames,
  readStopped,
  readThreads,
  readVariables,
  type DapBreakpoint,
  type DapCapabilities,
  type DapResponse,
  type DapScope,
  type DapStackFrame,
  type DapThread,
  type DapVariable
} from '../shared/dap-protocol'

/**
 * One debug session with one adapter.
 *
 * Same shape as the LSP client and for the same reasons: the transport is
 * injected so the awkward cases can be produced on demand, and the supervisor
 * above owns lifecycle while this owns the protocol.
 *
 * ## The launch sequence is the part that goes wrong
 *
 * A debug session is not "connect and go". It is a five-step dance whose order
 * is fixed and whose steps overlap:
 *
 *   1. `initialize` — the adapter replies with its capabilities.
 *   2. The adapter sends the `initialized` EVENT, which is not the response to
 *      step 1 and may arrive before it.
 *   3. Only after that event may breakpoints be configured.
 *   4. `configurationDone`, if the adapter said it supports it.
 *   5. `launch` or `attach`.
 *
 * Getting this wrong is the single most common way an integration fails, and it
 * fails as "the debugger starts and immediately exits" with nothing in any log.
 * Step 2 is where most of the trouble is: treating the `initialized` event as
 * the response to `initialize` deadlocks against adapters that send it first,
 * and waiting for the response before arming breakpoints races with adapters
 * that send it last. This client waits for BOTH, in either order.
 *
 * `launch` is deliberately sent last and NOT awaited before configuration is
 * done — several adapters do not answer `launch` until the program stops or
 * exits, so awaiting it before `configurationDone` hangs forever.
 */

/* -------------------------------------------------------------------------- */
/*  Transport                                                                  */
/* -------------------------------------------------------------------------- */

export interface DapTransport {
  write(bytes: Uint8Array): void
  onData(handler: (chunk: Uint8Array) => void): void
  onExit(handler: (code: number | null) => void): void
  kill(): void
}

/* -------------------------------------------------------------------------- */
/*  Events out                                                                 */
/* -------------------------------------------------------------------------- */

export interface DapClientEvents {
  /** Execution stopped. The UI fetches the stack from here. */
  onStopped(reason: string, threadId: number | null, description: string | null): void
  /** Execution resumed, so the UI clears its stack and locals. */
  onContinued(): void
  /** Program output, already categorised by the adapter. */
  onOutput(category: string, text: string): void
  /** The debuggee ended. */
  onTerminated(): void
  /** The adapter process ended, which is not the same thing. */
  onExit(code: number | null): void
  onNotice(notice: string): void
}

export interface SourceBreakpoint {
  readonly line: number
  readonly condition?: string
}

export interface DapClient {
  capabilities(): DapCapabilities
  /** Resolves once the adapter is configured and the program is launching. */
  start(config: Record<string, unknown>, adapterId: string): Promise<void>
  setBreakpoints(path: string, breakpoints: readonly SourceBreakpoint[]): Promise<DapBreakpoint[]>
  threads(): Promise<DapThread[]>
  stackTrace(threadId: number): Promise<DapStackFrame[]>
  scopes(frameId: number): Promise<DapScope[]>
  variables(reference: number): Promise<DapVariable[]>
  continue_(threadId: number): Promise<void>
  next(threadId: number): Promise<void>
  stepIn(threadId: number): Promise<void>
  stepOut(threadId: number): Promise<void>
  /** Only meaningful when `capabilities().supportsStepBack` is true. */
  stepBack(threadId: number): Promise<void>
  pause(threadId: number): Promise<void>
  evaluate(expression: string, frameId: number | null): Promise<string | null>
  disconnect(): Promise<void>
}

/**
 * Generous, because a launch can involve compiling.
 *
 * The C++ adapters in particular do real work before answering, and a short
 * deadline would abandon a session that was about to succeed.
 */
const LAUNCH_TIMEOUT_MS = 20_000

/** Short: these are answered from state the adapter already has. */
const REQUEST_TIMEOUT_MS = 5_000

const DISCONNECT_GRACE_MS = 1_000

interface Pending {
  readonly command: string
  readonly resolve: (response: DapResponse | null) => void
  readonly timer: ReturnType<typeof setTimeout>
}

export function createDapClient(transport: DapTransport, events: DapClientEvents): DapClient {
  const reader = createMessageReader()
  const pending = new Map<number, Pending>()

  let seq = 1
  let stopped = false
  let adapterCapabilities: DapCapabilities = {}

  /** Resolved when the adapter sends its `initialized` event. */
  let signalInitialized: (() => void) | null = null
  const initializedEvent = new Promise<void>((resolve) => {
    signalInitialized = resolve
  })

  /* ------------------------------- plumbing ------------------------------- */

  function request(
    command: string,
    args: unknown,
    timeoutMs = REQUEST_TIMEOUT_MS
  ): Promise<DapResponse | null> {
    if (stopped) return Promise.resolve(null)

    const requestSeq = seq++
    return new Promise<DapResponse | null>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestSeq)
        events.onNotice(`${command} timed out after ${timeoutMs}ms`)
        resolve(null)
      }, timeoutMs)
      timer.unref?.()

      pending.set(requestSeq, { command, resolve, timer })
      transport.write(
        encodeMessage({ seq: requestSeq, type: 'request', command, arguments: args })
      )
    })
  }

  /** The body of a successful response, or null. Failures become notices. */
  async function body(command: string, args: unknown, timeoutMs?: number): Promise<unknown> {
    const response = await request(command, args, timeoutMs)
    if (response === null) return null

    if (!response.success) {
      // A failed request is normal — stepping a thread that just exited, or
      // evaluating an expression that does not parse — so it is a notice rather
      // than an error, and callers get null.
      events.onNotice(`${command}: ${response.message ?? 'failed'}`)
      return null
    }

    return response.body ?? null
  }

  function settle(response: DapResponse): void {
    const waiting = pending.get(response.request_seq)
    if (waiting === undefined) return

    pending.delete(response.request_seq)
    clearTimeout(waiting.timer)
    waiting.resolve(response)
  }

  /* ------------------------------- receiving ------------------------------ */

  function handleEvent(name: string, payload: unknown): void {
    switch (name) {
      case 'initialized':
        // NOT the response to `initialize`, and it may arrive before it.
        signalInitialized?.()
        return
      case 'stopped': {
        const details = readStopped(payload)
        events.onStopped(details.reason, details.threadId ?? null, details.description ?? null)
        return
      }
      case 'continued':
        events.onContinued()
        return
      case 'output': {
        const output = readOutput(payload)
        if (output !== null) events.onOutput(output.category ?? 'console', output.output)
        return
      }
      case 'terminated':
      case 'exited':
        events.onTerminated()
        return
      default:
        // Adapters send plenty this client does not use — `thread`, `module`,
        // `loadedSource`, `progressStart`. Ignoring them silently is correct;
        // a notice each would bury the ones that matter.
        return
    }
  }

  function receive(chunk: Uint8Array): void {
    for (const framed of reader.push(chunk).messages) {
      let parsed: unknown
      try {
        parsed = JSON.parse(framed.body)
      } catch {
        events.onNotice('the adapter sent a message that is not JSON')
        continue
      }

      const record = parsed as Record<string, unknown>
      switch (classifyDapMessage(parsed)) {
        case 'response':
          settle(parsed as DapResponse)
          break
        case 'event':
          handleEvent(String(record['event']), record['body'])
          break
        case 'request':
          /*
           * `runInTerminal` is the only request adapters commonly send, and
           * this client declares it does not support it — so answering with a
           * failure is the honest reply. Staying silent would leave the adapter
           * waiting and the session would hang at launch.
           */
          transport.write(
            encodeMessage({
              seq: seq++,
              type: 'response',
              request_seq: record['seq'],
              success: false,
              command: String(record['command']),
              message: 'this client does not support adapter-initiated requests'
            })
          )
          break
        default:
          events.onNotice('the adapter sent something that is not a DAP message')
      }
    }
  }

  /* -------------------------------- launch -------------------------------- */

  async function start(config: Record<string, unknown>, adapterId: string): Promise<void> {
    const initialize = body('initialize', initializeArguments(adapterId), LAUNCH_TIMEOUT_MS)

    /*
     * Both, in either order. Treating the event as the response deadlocks
     * against adapters that send it first; waiting only for the response races
     * with adapters that send it last. Waiting for both is the only ordering
     * that works against every adapter.
     */
    const [capabilitiesBody] = await Promise.all([initialize, initializedEvent])
    if (stopped) return

    adapterCapabilities = readCapabilities(capabilitiesBody)

    // Breakpoints belong here — after `initialized`, before `configurationDone`
    // — and the caller sets them by awaiting `start` and then calling
    // `setBreakpoints`, which is why this resolves rather than blocking.
    if (adapterCapabilities.supportsConfigurationDoneRequest === true) {
      await body('configurationDone', {})
    }

    /*
     * Deliberately NOT awaited. Several adapters do not answer `launch` until
     * the program stops or exits, so awaiting it here hangs the session at
     * startup — the failure looks like the debugger never starting.
     */
    void request(config['request'] === 'attach' ? 'attach' : 'launch', config, LAUNCH_TIMEOUT_MS)
  }

  /* ------------------------------- commands ------------------------------- */

  async function setBreakpoints(
    path: string,
    breakpoints: readonly SourceBreakpoint[]
  ): Promise<DapBreakpoint[]> {
    const result = await body('setBreakpoints', {
      source: { path, name: path.split(/[\\/]/).pop() ?? path },
      breakpoints: breakpoints.map((breakpoint) => ({
        line: breakpoint.line,
        condition: breakpoint.condition
      })),
      // The adapter's own line numbering, which `initialize` asked to be
      // one-based — so these are the numbers the editor already uses.
      lines: breakpoints.map((breakpoint) => breakpoint.line)
    })

    return readBreakpoints(result)
  }

  async function evaluate(expression: string, frameId: number | null): Promise<string | null> {
    const result = await body('evaluate', {
      expression,
      frameId: frameId ?? undefined,
      context: 'watch'
    })

    if (result === null || typeof result !== 'object') return null
    const value = (result as Record<string, unknown>)['result']
    return typeof value === 'string' ? value : null
  }

  async function disconnect(): Promise<void> {
    if (stopped) return

    /*
     * `terminate` asks the debuggee to stop; `disconnect` detaches. Preferring
     * terminate where it is supported is what stops a debug session leaving a
     * process running with a breakpoint still set in it.
     */
    if (adapterCapabilities.supportsTerminateRequest === true) {
      await request('terminate', {}, DISCONNECT_GRACE_MS)
    }
    await request('disconnect', { terminateDebuggee: true }, DISCONNECT_GRACE_MS)

    stopped = true
    for (const waiting of pending.values()) {
      clearTimeout(waiting.timer)
      waiting.resolve(null)
    }
    pending.clear()

    transport.kill()
  }

  /* -------------------------------- wiring -------------------------------- */

  transport.onData(receive)
  transport.onExit((code) => {
    if (stopped) return
    stopped = true
    for (const waiting of pending.values()) {
      clearTimeout(waiting.timer)
      waiting.resolve(null)
    }
    pending.clear()
    events.onExit(code)
  })

  const stepping = (command: string) => async (threadId: number): Promise<void> => {
    await body(command, { threadId })
  }

  return {
    capabilities: () => adapterCapabilities,
    start,
    setBreakpoints,
    threads: async () => readThreads(await body('threads', {})),
    stackTrace: async (threadId) =>
      readStackFrames(await body('stackTrace', { threadId, startFrame: 0, levels: 64 })),
    scopes: async (frameId) => readScopes(await body('scopes', { frameId })),
    variables: async (reference) =>
      readVariables(await body('variables', { variablesReference: reference })),
    continue_: stepping('continue'),
    next: stepping('next'),
    stepIn: stepping('stepIn'),
    stepOut: stepping('stepOut'),
    stepBack: stepping('stepBack'),
    pause: stepping('pause'),
    evaluate,
    disconnect
  }
}
