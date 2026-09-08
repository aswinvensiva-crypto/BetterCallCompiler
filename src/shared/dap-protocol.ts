/**
 * The Debug Adapter Protocol, as much of it as a debugger UI needs.
 *
 * DAP reuses the framing in `jsonrpc-framing.ts` and nothing else: where LSP is
 * JSON-RPC 2.0, DAP has its own envelope with a `type` field that actually
 * discriminates — `request`, `response` or `event` — and a `seq` counter
 * instead of an id. That is a genuinely better design to consume, and it means
 * the classify-by-shape guesswork the LSP client needs has no equivalent here.
 *
 * ## Why nouns, and why not the wire
 *
 * The BCC plan commits to DAP's NOUNS for its own debugger — threads,
 * stackFrames, scopes, variables, setBreakpoints — while explicitly not
 * implementing the wire format, because "its only payoff is third-party client
 * compatibility, which a solo project does not need". This module is the other
 * half of that decision: BCC's own VM will be driven through the same nouns,
 * and a real external adapter is driven through these types. One debugger UI,
 * two backends, and the seam is a vocabulary both already speak.
 *
 * ## Lines are one-based here and negotiable there
 *
 * DAP is one-based by default for both lines and columns — the opposite of LSP,
 * and the same as this app. But it is NEGOTIABLE: `initialize` carries
 * `linesStartAt1` and `columnsStartAt1`, and an adapter may honour whatever the
 * client asks for. The client asks for one-based, which makes the conversion a
 * no-op, and that is worth stating rather than leaving as a coincidence
 * somebody later "fixes".
 */

/* -------------------------------------------------------------------------- */
/*  Envelopes                                                                  */
/* -------------------------------------------------------------------------- */

export interface DapRequest {
  readonly seq: number
  readonly type: 'request'
  readonly command: string
  readonly arguments?: unknown
}

export interface DapResponse {
  readonly seq: number
  readonly type: 'response'
  /** The `seq` of the request this answers. */
  readonly request_seq: number
  readonly success: boolean
  readonly command: string
  /** Present when `success` is false. */
  readonly message?: string
  readonly body?: unknown
}

export interface DapEvent {
  readonly seq: number
  readonly type: 'event'
  readonly event: string
  readonly body?: unknown
}

export type DapMessage = DapRequest | DapResponse | DapEvent

/**
 * Which envelope this is.
 *
 * Unlike JSON-RPC, DAP carries a discriminator, so this is a read rather than
 * an inference. Keeping it a function anyway means a malformed message is
 * classified as unknown in one place rather than throwing wherever it lands.
 */
export function classifyDapMessage(message: unknown): DapMessage['type'] | 'unknown' {
  if (typeof message !== 'object' || message === null) return 'unknown'

  const type = (message as Record<string, unknown>)['type']
  return type === 'request' || type === 'response' || type === 'event' ? type : 'unknown'
}

/* -------------------------------------------------------------------------- */
/*  The nouns                                                                  */
/* -------------------------------------------------------------------------- */

export interface DapSource {
  readonly name?: string
  readonly path?: string
}

export interface DapBreakpoint {
  readonly id?: number
  /**
   * Whether the adapter accepted it.
   *
   * A breakpoint set on a blank line or inside a comment comes back
   * `verified: false`, usually with the line it moved to. Showing it as a solid
   * red dot anyway is the single most common way a debugger UI lies to its
   * user — they then watch execution run past a breakpoint that was never
   * really set.
   */
  readonly verified: boolean
  readonly line?: number
  readonly message?: string
}

export interface DapThread {
  readonly id: number
  readonly name: string
}

export interface DapStackFrame {
  readonly id: number
  readonly name: string
  readonly source?: DapSource
  readonly line: number
  readonly column: number
}

export interface DapScope {
  readonly name: string
  readonly variablesReference: number
  /**
   * A hint that this scope is costly to expand — a global scope with thousands
   * of entries. The UI collapses these by default rather than fetching them.
   */
  readonly expensive?: boolean
}

export interface DapVariable {
  readonly name: string
  readonly value: string
  readonly type?: string
  /** Non-zero means this variable has children, fetched with another request. */
  readonly variablesReference: number
}

/** Why execution stopped. `reason` is free text in practice; these are the common ones. */
export interface DapStoppedEvent {
  readonly reason: string
  readonly threadId?: number
  readonly description?: string
  readonly text?: string
  /** True when every thread stopped, which is the usual case. */
  readonly allThreadsStopped?: boolean
}

export interface DapOutputEvent {
  /** `stdout`, `stderr`, `console`, or an adapter-specific category. */
  readonly category?: string
  readonly output: string
}

export interface DapTerminatedEvent {
  readonly restart?: unknown
}

/* -------------------------------------------------------------------------- */
/*  Capabilities                                                               */
/* -------------------------------------------------------------------------- */

/**
 * What the adapter says it can do.
 *
 * Every field is optional and absent means false. That is not pedantry: asking
 * an adapter for something it did not advertise is how a debug session ends in
 * an error dialogue mid-step, and the two below are exactly the features the
 * BCC plan's time-travel amendment will need to ask about.
 */
export interface DapCapabilities {
  readonly supportsConfigurationDoneRequest?: boolean
  readonly supportsStepBack?: boolean
  readonly supportsRestartRequest?: boolean
  readonly supportsTerminateRequest?: boolean
  readonly supportsEvaluateForHovers?: boolean
  readonly supportsConditionalBreakpoints?: boolean
}

/**
 * What this client tells the adapter about itself.
 *
 * `linesStartAt1` and `columnsStartAt1` are the important pair: asking for
 * one-based makes every position in this module agree with `sourceRangeSchema`,
 * Monaco and the rest of the app with no conversion at all. Asking for
 * zero-based would have introduced the same ±1 hazard the LSP boundary has, for
 * no benefit.
 */
export interface DapInitializeArguments {
  readonly clientID: string
  readonly clientName: string
  readonly adapterID: string
  readonly linesStartAt1: true
  readonly columnsStartAt1: true
  readonly pathFormat: 'path'
  readonly supportsRunInTerminalRequest: false
  readonly locale: string
}

export function initializeArguments(adapterId: string): DapInitializeArguments {
  return {
    clientID: 'bettercallcompiler',
    clientName: 'BetterCallCompiler',
    adapterID: adapterId,
    linesStartAt1: true,
    columnsStartAt1: true,
    pathFormat: 'path',
    // Running the debuggee in the user's terminal is a real feature and this
    // client does not implement it. Claiming it and then failing the request
    // ends the session at launch, which is worse than not offering it.
    supportsRunInTerminalRequest: false,
    locale: 'en'
  }
}

/* -------------------------------------------------------------------------- */
/*  Reading adapter payloads                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Adapters are not uniformly careful about their own schema, and a debugger UI
 * that throws on a missing optional field is one that dies mid-session against
 * a debugger somebody actually uses. Every reader below returns something
 * usable for input it does not recognise.
 */

export function readThreads(body: unknown): DapThread[] {
  const raw = arrayField(body, 'threads')
  return raw.flatMap((entry) => {
    const record = asRecord(entry)
    if (record === null) return []
    const id = record['id']
    return typeof id === 'number' ? [{ id, name: stringOr(record['name'], `Thread ${id}`) }] : []
  })
}

export function readStackFrames(body: unknown): DapStackFrame[] {
  const raw = arrayField(body, 'stackFrames')
  return raw.flatMap((entry) => {
    const record = asRecord(entry)
    if (record === null) return []
    const id = record['id']
    if (typeof id !== 'number') return []

    const source = asRecord(record['source'])
    return [
      {
        id,
        name: stringOr(record['name'], '<anonymous>'),
        source:
          source === null
            ? undefined
            : { name: optionalString(source['name']), path: optionalString(source['path']) },
        // A frame with no line is a frame the UI cannot navigate to; 0 keeps it
        // listed and unclickable rather than dropping it from the stack, which
        // would renumber every frame below it.
        line: numberOr(record['line'], 0),
        column: numberOr(record['column'], 0)
      }
    ]
  })
}

export function readScopes(body: unknown): DapScope[] {
  return arrayField(body, 'scopes').flatMap((entry) => {
    const record = asRecord(entry)
    if (record === null) return []
    return [
      {
        name: stringOr(record['name'], 'Scope'),
        variablesReference: numberOr(record['variablesReference'], 0),
        expensive: record['expensive'] === true
      }
    ]
  })
}

export function readVariables(body: unknown): DapVariable[] {
  return arrayField(body, 'variables').flatMap((entry) => {
    const record = asRecord(entry)
    if (record === null) return []
    return [
      {
        name: stringOr(record['name'], ''),
        // The adapter has already rendered this for display; it is a string by
        // specification, and an adapter sending a number means the UI shows
        // "undefined" unless it is coerced.
        value: record['value'] === undefined ? '' : String(record['value']),
        type: optionalString(record['type']),
        variablesReference: numberOr(record['variablesReference'], 0)
      }
    ]
  })
}

export function readBreakpoints(body: unknown): DapBreakpoint[] {
  return arrayField(body, 'breakpoints').flatMap((entry) => {
    const record = asRecord(entry)
    if (record === null) return []
    return [
      {
        id: typeof record['id'] === 'number' ? record['id'] : undefined,
        // Absent means NOT verified. Defaulting the other way would show a
        // solid red dot for a breakpoint the adapter never set.
        verified: record['verified'] === true,
        line: typeof record['line'] === 'number' ? record['line'] : undefined,
        message: optionalString(record['message'])
      }
    ]
  })
}

export function readCapabilities(body: unknown): DapCapabilities {
  const record = asRecord(body)
  if (record === null) return {}

  const flag = (name: string): boolean | undefined =>
    typeof record[name] === 'boolean' ? (record[name] as boolean) : undefined

  return {
    supportsConfigurationDoneRequest: flag('supportsConfigurationDoneRequest'),
    supportsStepBack: flag('supportsStepBack'),
    supportsRestartRequest: flag('supportsRestartRequest'),
    supportsTerminateRequest: flag('supportsTerminateRequest'),
    supportsEvaluateForHovers: flag('supportsEvaluateForHovers'),
    supportsConditionalBreakpoints: flag('supportsConditionalBreakpoints')
  }
}

export function readStopped(body: unknown): DapStoppedEvent {
  const record = asRecord(body)
  if (record === null) return { reason: 'unknown' }

  return {
    reason: stringOr(record['reason'], 'unknown'),
    threadId: typeof record['threadId'] === 'number' ? record['threadId'] : undefined,
    description: optionalString(record['description']),
    text: optionalString(record['text']),
    allThreadsStopped: record['allThreadsStopped'] === true
  }
}

export function readOutput(body: unknown): DapOutputEvent | null {
  const record = asRecord(body)
  if (record === null) return null

  const output = record['output']
  if (typeof output !== 'string') return null
  return { category: optionalString(record['category']), output }
}

/* --------------------------------- helpers -------------------------------- */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function arrayField(body: unknown, name: string): unknown[] {
  const record = asRecord(body)
  const field = record?.[name]
  return Array.isArray(field) ? field : []
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value !== '' ? value : fallback
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
