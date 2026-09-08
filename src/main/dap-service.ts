import { promises as fsp } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import {
  adapterForLanguage,
  adapterForPath,
  DAP_ADAPTERS,
  type DapAdapterSpec
} from '../shared/dap-registry'
import { BetterCallCompilerServiceError } from '../shared/ipc-contract'
import type {
  DapAdapterStatusRecord,
  DapBreakpointRecord,
  DapOutputRecord,
  DapScopeRecord,
  DapSessionState,
  DapSessionStatusRecord,
  DapStackFrameRecord,
  DapThreadRecord,
  DapVariableRecord
} from '../shared/types'
import { buildDirectoryFor } from './runner'
import { findOnPath, spawnExecutable } from './toolchains'
import {
  createDapClient,
  type DapClient,
  type DapClientEvents,
  type DapTransport,
  type SourceBreakpoint
} from './dap-client'
import type { DapBreakpoint, DapScope, DapStackFrame, DapVariable } from '../shared/dap-protocol'

/**
 * The DAP supervisor: one active debug session at a time, against a real
 * external adapter (`dap-registry.ts`).
 *
 * Matches `lsp-service.ts`'s split — the client owns the protocol, this owns
 * the lifecycle — but the lifecycle itself is different in kind. A language
 * server starts lazily and stays up for as long as the workspace is open; a
 * debug session is started deliberately, runs once, and ends. So there is no
 * restart budget here: an adapter that dies mid-session is a session that
 * ended, not a service to nurse back up, and silently relaunching it behind
 * the user's back would restart their program without them asking.
 *
 * ## Breakpoints outlive any one session
 *
 * They are workspace state the user sets before a session exists and toggles
 * during one — the same shape VS Code's gutter has. Stored here keyed by
 * absolute path regardless of whether anything is running, applied
 * immediately when a session is active, and replayed onto every new session
 * for every file that has any, not only the one being launched: a program's
 * breakpoints can live in files other than its entry point.
 */

/* -------------------------------------------------------------------------- */
/*  State                                                                      */
/* -------------------------------------------------------------------------- */

interface ActiveSession {
  readonly id: string
  readonly spec: DapAdapterSpec
  readonly relativePath: string
  /** Assigned once, immediately after construction — see `startDapSession`. */
  client: DapClient
  state: DapSessionState
  stoppedReason: string | null
  threadId: number | null
  /** False once replaced or torn down — event handlers check this before acting. */
  live: boolean
}

let workspaceRoot: string | null = null
let current: ActiveSession | null = null
let sequence = 0

/** Absolute path → the lines the user has set, regardless of any session. */
const breakpointsByPath = new Map<string, number[]>()

let emitStatus: ((status: DapSessionStatusRecord | null) => void) | null = null
let emitOutput: ((payload: DapOutputRecord) => void) | null = null
let emitNotice: ((notice: string) => void) | null = null
let commandProbe: ((command: string) => string | null) | null = null
let transportFactory:
  | ((spec: DapAdapterSpec, command: string, root: string) => DapTransport | null)
  | null = null

export function setDapEmitters(
  onStatus: (status: DapSessionStatusRecord | null) => void,
  onOutput: (payload: DapOutputRecord) => void,
  onNotice: (notice: string) => void
): void {
  emitStatus = onStatus
  emitOutput = onOutput
  emitNotice = onNotice
}

/** Injected so the supervisor can be tested without spawning a process. */
export function setDapTransportFactory(
  factory: ((spec: DapAdapterSpec, command: string, root: string) => DapTransport | null) | null
): void {
  transportFactory = factory
}

/** How a command is looked up on PATH — injected for the same reason. */
export function setDapCommandProbe(probe: ((command: string) => string | null) | null): void {
  commandProbe = probe
}

function lookUp(command: string): string | null {
  return (commandProbe ?? findOnPath)(command)
}

/**
 * Starts (or restarts) the supervisor against `root`.
 *
 * Ends whatever session was running for the previous workspace — a debug
 * session pointed at a file that no longer belongs to the open workspace is
 * not a session anything should keep running.
 */
export function startDap(root: string | null): void {
  void stopDap()
  workspaceRoot = root
}

/** Ends the active session, if there is one. A no-op otherwise. */
export async function stopDap(): Promise<void> {
  const entry = current
  if (entry === null) return
  entry.live = false
  current = null
  emitStatus?.(null)
  await entry.client.disconnect()
}

/* -------------------------------------------------------------------------- */
/*  Adapter status                                                             */
/* -------------------------------------------------------------------------- */

export function dapAdapters(): readonly DapAdapterStatusRecord[] {
  return DAP_ADAPTERS.map((spec) => ({
    id: spec.id,
    displayName: spec.displayName,
    languageIds: [...spec.languageIds],
    installed: spec.commands.some((command) => lookUp(command) !== null),
    installHint: spec.installHint
  }))
}

/* -------------------------------------------------------------------------- */
/*  Breakpoints                                                                */
/* -------------------------------------------------------------------------- */

function toBreakpointRecord(breakpoint: DapBreakpoint, fallbackLine: number): DapBreakpointRecord {
  return {
    line: breakpoint.line ?? fallbackLine,
    verified: breakpoint.verified,
    message: breakpoint.message ?? null
  }
}

/**
 * Records the breakpoints for one file and, when a session is active, applies
 * them immediately.
 *
 * Returns the adapter's verdict when there is one to ask, or every line
 * marked unverified when there is not — a breakpoint set before any session
 * exists has not been confirmed by anything yet, and claiming otherwise is
 * exactly the lie `dap-protocol.ts`'s own note on `verified` warns against.
 */
export async function setDapBreakpoints(
  absolutePath: string,
  lines: readonly number[]
): Promise<DapBreakpointRecord[]> {
  if (lines.length === 0) breakpointsByPath.delete(absolutePath)
  else breakpointsByPath.set(absolutePath, [...lines])

  if (current === null) {
    return lines.map((line) => ({ line, verified: false, message: null }))
  }

  const sourceBreakpoints: SourceBreakpoint[] = lines.map((line) => ({ line }))
  const result = await current.client.setBreakpoints(absolutePath, sourceBreakpoints)
  return result.map((breakpoint, index) => toBreakpointRecord(breakpoint, lines[index] ?? 0))
}

async function replayBreakpoints(client: DapClient): Promise<void> {
  await Promise.all(
    [...breakpointsByPath.entries()].map(([path, lines]) =>
      client.setBreakpoints(
        path,
        lines.map((line) => ({ line }))
      )
    )
  )
}

/* -------------------------------------------------------------------------- */
/*  Building a program to debug                                               */
/* -------------------------------------------------------------------------- */

interface CompletedProcess {
  readonly code: number | null
  readonly stderr: string
}

/** Generous but bounded: a stuck compiler must not hang a debug launch forever. */
const COMPILE_TIMEOUT_MS = 30_000

function runToCompletion(
  command: string,
  args: readonly string[],
  cwd: string
): Promise<CompletedProcess> {
  return new Promise((resolve) => {
    const child = spawnExecutable(command, args, { cwd })
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      resolve({ code: null, stderr: `${stderr}\n(timed out after ${COMPILE_TIMEOUT_MS}ms)` })
    }, COMPILE_TIMEOUT_MS)

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: null, stderr: error.message })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stderr })
    })
  })
}

/**
 * GDB's DAP `launch` takes a compiled binary, not source — unlike Python,
 * where the interpreter *is* the program. Compiling here, with debug symbols
 * and no optimisation, is what makes the breakpoints and the variables the
 * user is about to ask for correspond to the source they are looking at.
 *
 * Reuses `runner.ts`'s build directory so the artefact lands somewhere
 * already git-ignored and already excluded from the watcher, rather than a
 * second convention for where compiled output goes.
 */
async function compileForDebug(absolutePath: string, root: string): Promise<string> {
  const isC = extname(absolutePath).toLowerCase() === '.c'
  const compiler = isC ? 'gcc' : 'g++'
  const resolved = lookUp(compiler)
  if (resolved === null) {
    throw new BetterCallCompilerServiceError(
      'UNSUPPORTED',
      `${compiler} is not on your PATH; it is needed to build a debuggable binary.`
    )
  }

  const stem = basename(absolutePath, extname(absolutePath))
  const outputPath = join(
    buildDirectoryFor(root),
    `${stem}-debug${process.platform === 'win32' ? '.exe' : ''}`
  )
  await fsp.mkdir(dirname(outputPath), { recursive: true })

  const outcome = await runToCompletion(resolved, ['-g', '-O0', absolutePath, '-o', outputPath], root)
  if (outcome.code !== 0) {
    throw new BetterCallCompilerServiceError(
      'HANDLER_FAILED',
      `compile failed:\n${outcome.stderr.slice(0, 4_000)}`
    )
  }
  return outputPath
}

/**
 * The `launch` request body, which is entirely adapter-specific — DAP defines
 * the envelope, not the arguments, and every adapter documents its own.
 */
function launchConfig(spec: DapAdapterSpec, programPath: string, root: string): Record<string, unknown> {
  if (spec.id === 'debugpy') {
    return {
      request: 'launch',
      type: 'python',
      name: 'BetterCallCompiler',
      program: programPath,
      cwd: root,
      console: 'internalConsole',
      stopOnEntry: false
    }
  }

  // gdb --interpreter=dap: `stopAtBeginningOfMainSubprogram` is its documented
  // name for "break at the start of main", not the `stopOnEntry` other
  // adapters use.
  return {
    request: 'launch',
    program: programPath,
    cwd: root,
    stopAtBeginningOfMainSubprogram: false
  }
}

/* -------------------------------------------------------------------------- */
/*  Transport                                                                  */
/* -------------------------------------------------------------------------- */

function spawnTransport(command: string, args: readonly string[], cwd: string): DapTransport {
  const child = spawnExecutable(command, args, { cwd })

  return {
    write(bytes) {
      if (child.stdin?.writable === true) child.stdin.write(bytes)
    },
    onData(handler) {
      child.stdout?.on('data', (chunk: Buffer) => handler(chunk))
    },
    onExit(handler) {
      child.on('exit', (code) => handler(code))
    },
    kill() {
      child.kill()
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Starting a session                                                         */
/* -------------------------------------------------------------------------- */

function toStatusRecord(entry: ActiveSession): DapSessionStatusRecord {
  return {
    sessionId: entry.id,
    adapterId: entry.spec.id,
    relativePath: entry.relativePath,
    state: entry.state,
    stoppedReason: entry.stoppedReason,
    threadId: entry.threadId,
    supportsStepBack: entry.client.capabilities().supportsStepBack === true
  }
}

/**
 * Starts a debug session for `absolutePath`, ending whatever session was
 * already running.
 *
 * Throws `UNSUPPORTED` when nothing can debug this language — no adapter in
 * the registry, or the adapter's command is not on PATH — with the registry's
 * own install hint, the same shape a missing toolchain already answers with
 * in `planRun`.
 */
export async function startDapSession(
  relativePath: string,
  absolutePath: string,
  languageId: string
): Promise<DapSessionStatusRecord> {
  const root = workspaceRoot
  if (root === null) {
    throw new BetterCallCompilerServiceError('NO_WORKSPACE', 'open a folder before debugging')
  }

  const spec = adapterForLanguage(languageId) ?? adapterForPath(absolutePath)
  if (spec === null) {
    throw new BetterCallCompilerServiceError(
      'UNSUPPORTED',
      `BetterCallCompiler cannot debug this file yet — no debug adapter is registered for it.`
    )
  }

  const resolvedCommand = spec.commands.map(lookUp).find((path): path is string => path !== null)
  if (resolvedCommand === undefined) {
    throw new BetterCallCompilerServiceError('UNSUPPORTED', spec.installHint)
  }

  await stopDap()

  const programPath = spec.id === 'gdb' ? await compileForDebug(absolutePath, root) : absolutePath

  const defaultTransport = (usedSpec: DapAdapterSpec, command: string, cwd: string): DapTransport =>
    spawnTransport(command, usedSpec.args, cwd)
  const transport = (transportFactory ?? defaultTransport)(spec, resolvedCommand, root) ?? null
  if (transport === null) {
    throw new BetterCallCompilerServiceError('UNSUPPORTED', spec.installHint)
  }

  const id = `dap-${++sequence}`
  // `client` is filled in immediately below, before the transport can produce
  // any event — `events` closes over `entry` rather than over the client
  // directly so the two can be constructed in the order `createDapClient`
  // requires (events before client) despite each event handler needing the
  // finished client to disconnect with.
  const entry = {
    id,
    spec,
    relativePath,
    state: 'starting',
    stoppedReason: null,
    threadId: null,
    live: true
  } as ActiveSession

  const events: DapClientEvents = {
    onStopped: (reason, threadId) => {
      if (!entry.live) return
      entry.state = 'stopped'
      entry.stoppedReason = reason
      entry.threadId = threadId
      emitStatus?.(toStatusRecord(entry))
    },
    onContinued: () => {
      if (!entry.live) return
      entry.state = 'running'
      entry.stoppedReason = null
      entry.threadId = null
      emitStatus?.(toStatusRecord(entry))
    },
    onOutput: (category, text) => {
      if (!entry.live) return
      emitOutput?.({ sessionId: entry.id, category, text })
    },
    onTerminated: () => {
      if (!entry.live) return
      entry.live = false
      entry.state = 'terminated'
      if (current === entry) current = null
      emitStatus?.(toStatusRecord(entry))
      void entry.client.disconnect()
    },
    onExit: () => {
      if (!entry.live) return
      entry.live = false
      if (current === entry) current = null
      emitStatus?.(null)
    },
    onNotice: (notice) => {
      emitNotice?.(notice)
    }
  }

  entry.client = createDapClient(transport, events)

  current = entry
  emitStatus?.(toStatusRecord(entry))

  await entry.client.start(launchConfig(spec, programPath, root), spec.adapterId)
  await replayBreakpoints(entry.client)

  if (entry.live) entry.state = 'running'
  emitStatus?.(toStatusRecord(entry))
  return toStatusRecord(entry)
}

/* -------------------------------------------------------------------------- */
/*  Controls and queries — no-ops without a session, per the LSP philosophy   */
/*  that a query never throws: the UI already disables these without one.    */
/* -------------------------------------------------------------------------- */

export async function dapContinue(): Promise<void> {
  if (current === null || current.threadId === null) return
  await current.client.continue_(current.threadId)
}

export async function dapStepOver(): Promise<void> {
  if (current === null || current.threadId === null) return
  await current.client.next(current.threadId)
}

export async function dapStepIn(): Promise<void> {
  if (current === null || current.threadId === null) return
  await current.client.stepIn(current.threadId)
}

export async function dapStepOut(): Promise<void> {
  if (current === null || current.threadId === null) return
  await current.client.stepOut(current.threadId)
}

/** Only meaningful when `current`'s capabilities report `supportsStepBack`. */
export async function dapStepBack(): Promise<void> {
  if (current === null || current.threadId === null) return
  await current.client.stepBack(current.threadId)
}

export async function dapPause(): Promise<void> {
  if (current === null || current.threadId === null) return
  await current.client.pause(current.threadId)
}

export function dapThreads(): Promise<readonly DapThreadRecord[]> {
  if (current === null) return Promise.resolve([])
  return current.client.threads()
}

export function dapStackTrace(threadId: number): Promise<readonly DapStackFrameRecord[]> {
  if (current === null) return Promise.resolve([])
  return current.client.stackTrace(threadId).then((frames: DapStackFrame[]) =>
    frames.map((frame) => ({
      id: frame.id,
      name: frame.name,
      path: frame.source?.path ?? null,
      line: frame.line,
      column: frame.column
    }))
  )
}

export function dapScopes(frameId: number): Promise<readonly DapScopeRecord[]> {
  if (current === null) return Promise.resolve([])
  return current.client.scopes(frameId).then((scopes: DapScope[]) =>
    scopes.map((scope) => ({
      name: scope.name,
      variablesReference: scope.variablesReference,
      expensive: scope.expensive === true
    }))
  )
}

export function dapVariables(reference: number): Promise<readonly DapVariableRecord[]> {
  if (current === null) return Promise.resolve([])
  return current.client.variables(reference).then((variables: DapVariable[]) =>
    variables.map((variable) => ({
      name: variable.name,
      value: variable.value,
      type: variable.type ?? null,
      variablesReference: variable.variablesReference
    }))
  )
}

export function dapEvaluate(expression: string, frameId: number | null): Promise<string | null> {
  if (current === null) return Promise.resolve(null)
  return current.client.evaluate(expression, frameId)
}

/** For tests, which must not inherit another file's session or breakpoints. */
export function resetDapForTests(): void {
  current = null
  workspaceRoot = null
  sequence = 0
  breakpointsByPath.clear()
  emitStatus = null
  emitOutput = null
  emitNotice = null
  transportFactory = null
  commandProbe = null
}
