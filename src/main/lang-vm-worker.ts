import { parentPort } from 'node:worker_threads'
import { compileModule, BytecodeError } from '../lang/bytecode'
import { lower, TOP_LEVEL_FUNCTION } from '../lang/lower'
import { runPipeline } from '../lang/pass-manager'
import { OPTIMISATION_PIPELINE } from '../lang/passes'
import { parseSource } from '../lang/parser'
import { resolve } from '../lang/symbols'
import { typeCheck } from '../lang/type-check'
import { createVm, type Vm } from '../lang/vm'
import { createDebugSession, type DebugSession, type DebugStop } from '../lang/debug'
import type { DapBreakpoint, DapStackFrame, DapVariable } from '../shared/dap-protocol'

/**
 * Running a `.bcc` program, off the main thread.
 *
 * A worker for the reason the plan gives: "a runaway loop cannot freeze the
 * window". The VM has its own step limit, but a limit of fifty million
 * instructions is still seconds of solid compute, and the editor has to stay
 * responsive through it — including responsive enough to be told to stop.
 *
 * ## Output is drained, not streamed per instruction
 *
 * The VM records output rather than performing it, which is what makes
 * stepping backwards honest. That leaves this worker to decide when to hand it
 * over. Posting per `print` would be one message per instruction on a loop that
 * prints; posting only at the end would make a long-running program look hung.
 * So the loop runs in slices and drains whatever accumulated after each — the
 * output arrives promptly and the message count is bounded by duration rather
 * than by how much the program printed.
 *
 * ## Why the whole pipeline runs here
 *
 * The alternative was compiling in the main process and sending bytecode over.
 * That would mean a second copy of the compiler's output crossing a structured
 * clone, and it would put compilation — which can throw — on the thread that
 * owns the window. Sending source and getting back output keeps the failure
 * domain inside the worker, which is the same argument `lang-worker.ts` makes
 * for the checker.
 */

/* -------------------------------------------------------------------------- */
/*  Protocol                                                                   */
/* -------------------------------------------------------------------------- */

export interface VmRunRequest {
  readonly type: 'run'
  readonly runId: string
  readonly source: string
  /** For diagnostics that name the file. */
  readonly relativePath: string
}

export interface VmCancelRequest {
  readonly type: 'cancel'
  readonly runId: string
}

/**
 * Start a program PAUSED, under debugger control.
 *
 * A separate request from `run` rather than a flag on it, because the two are
 * different lifecycles: a run streams to completion and ends, a debug session
 * waits for commands and can outlive several of them. Conflating them would
 * mean every `run` carried a mode nobody reads.
 */
export interface VmDebugRequest {
  readonly type: 'debug'
  readonly runId: string
  readonly source: string
  readonly relativePath: string
  readonly breakpoints: readonly number[]
}

export type DebugCommand =
  | 'continue'
  | 'stepInto'
  | 'stepOver'
  | 'stepOut'
  | 'stepBack'
  | 'reverseContinue'

export interface VmCommandRequest {
  readonly type: 'command'
  readonly runId: string
  readonly command: DebugCommand
}

export interface VmBreakpointsRequest {
  readonly type: 'breakpoints'
  readonly runId: string
  readonly lines: readonly number[]
}

export type VmWorkerRequest =
  | VmRunRequest
  | VmCancelRequest
  | VmDebugRequest
  | VmCommandRequest
  | VmBreakpointsRequest

export interface VmOutputMessage {
  readonly type: 'output'
  readonly runId: string
  readonly stream: 'stdout' | 'stderr'
  readonly text: string
}

export interface VmExitMessage {
  readonly type: 'exit'
  readonly runId: string
  /** 0 success, 1 a program error, 2 a compile error, 130 cancelled. */
  readonly code: number
  readonly steps: number
}

/**
 * Everything the debugger UI paints, after every command.
 *
 * One message rather than a stop event the UI then queries three more times.
 * The state is small — a handful of frames and a handful of locals — and a
 * round trip per pane would show a half-updated view while they arrived.
 */
export interface VmStoppedMessage {
  readonly type: 'stopped'
  readonly runId: string
  readonly stop: DebugStop
  readonly frames: readonly DapStackFrame[]
  /** Locals per frame, keyed by the frame id, which is its depth. */
  readonly locals: readonly { readonly frameId: number; readonly variables: readonly DapVariable[] }[]
  readonly output: string
  readonly breakpoints: readonly DapBreakpoint[]
  readonly finished: boolean
}

export type VmWorkerMessage = VmOutputMessage | VmExitMessage | VmStoppedMessage

export function isVmWorkerRequest(value: unknown): value is VmWorkerRequest {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (typeof record['runId'] !== 'string') return false

  // Enumerated by hand, which is the one thing TypeScript does not check here —
  // the same gap `isWorkerMessage` has, and the same reason it gets a test.
  const type = record['type']
  return (
    type === 'run' ||
    type === 'cancel' ||
    type === 'debug' ||
    type === 'command' ||
    type === 'breakpoints'
  )
}

/* -------------------------------------------------------------------------- */
/*  Slicing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Instructions per slice before yielding to drain output and check for cancel.
 *
 * Small enough that a cancel is honoured promptly — 50k instructions is under a
 * millisecond — and large enough that the slicing costs nothing measurable on a
 * program that runs for a while.
 */
export const SLICE_STEPS = 50_000

/* -------------------------------------------------------------------------- */
/*  Compiling and running                                                      */
/* -------------------------------------------------------------------------- */

export interface CompileOutcome {
  readonly vm: Vm | null
  /** Present when the program could not be built. */
  readonly errors: readonly string[]
}

/**
 * Source to a ready VM, or the reasons it could not be.
 *
 * Exported and pure so the tests can drive every failure — a parse error, a
 * type error, IR the pipeline rejects — without a worker.
 */
export function prepare(source: string, relativePath: string): CompileOutcome {
  const { program, diagnostics } = parseSource(source)

  const where = (line: number, column: number): string => `${relativePath}:${line}:${column}`
  const reported = diagnostics.map(
    (diagnostic) =>
      `${where(diagnostic.span.startLine, diagnostic.span.startColumn)} ${diagnostic.code}: ${diagnostic.message}`
  )
  if (reported.length > 0) return { vm: null, errors: reported }

  const resolution = resolve(program)
  const typeInfo = typeCheck(program, resolution)

  /*
   * Type errors are collected from the same place the daemon publishes them,
   * so the Run panel and the Problems panel cannot disagree about whether a
   * program is runnable.
   */
  const semantic = [...resolution.diagnostics, ...typeInfo.diagnostics].map(
    (diagnostic) =>
      `${where(diagnostic.span.startLine, diagnostic.span.startColumn)} ${diagnostic.code}: ${diagnostic.message}`
  )
  if (semantic.length > 0) return { vm: null, errors: semantic }

  const report = runPipeline(lower(program, resolution, typeInfo), OPTIMISATION_PIPELINE)
  if (report.failure !== null) {
    // The verifier refused a pass. This is a compiler bug rather than a program
    // one, and saying so is more useful than blaming the user's code.
    return { vm: null, errors: [`internal compiler error: ${report.failure.message}`] }
  }

  try {
    return { vm: createVm(compileModule(report.module, TOP_LEVEL_FUNCTION)), errors: [] }
  } catch (error) {
    if (error instanceof BytecodeError) {
      return {
        vm: null,
        errors: [`${where(error.span.startLine, error.span.startColumn)} ${error.message}`]
      }
    }
    return { vm: null, errors: [`internal compiler error: ${String(error)}`] }
  }
}

/* -------------------------------------------------------------------------- */
/*  The worker loop                                                            */
/* -------------------------------------------------------------------------- */

const port = parentPort

if (port !== null) {
  let cancelled: string | null = null

  /**
   * Live debug sessions, keyed by run.
   *
   * A map rather than a single slot because the worker's protocol is addressed
   * by `runId` everywhere else, and a session that answered commands addressed
   * to a run it is not would be the worst kind of bug to find later.
   *
   * `last` is the stop that put the machine where it is. Kept so that changing
   * breakpoints mid-session can re-send the current state without inventing a
   * reason the machine never stopped for.
   */
  const sessions = new Map<string, { readonly session: DebugSession; last: DebugStop }>()

  const post = (message: VmWorkerMessage): void => port.postMessage(message)

  port.on('message', (value: unknown) => {
    if (!isVmWorkerRequest(value)) return

    switch (value.type) {
      case 'cancel':
        cancelled = value.runId
        endSession(value.runId)
        return
      case 'run':
        void execute(value)
        return
      case 'debug':
        startSession(value)
        return
      case 'command':
        runCommand(value)
        return
      case 'breakpoints':
        rearm(value)
        return
    }
  })

  /* ------------------------------ debugging ----------------------------- */

  /**
   * Everything the UI paints, computed fresh from the VM.
   *
   * Output is the WHOLE buffer, not what arrived since the last message. A run
   * can only append, so draining is right there; a debug session can step
   * BACKWARDS, which un-prints. An incremental channel cannot express that, so
   * the UI replaces its transcript rather than appending to it — and stepping
   * back over a `print` visibly removes the line, which is the demo.
   */
  function report(runId: string, entry: { readonly session: DebugSession; last: DebugStop }): void {
    const { session } = entry
    post({
      type: 'stopped',
      runId,
      stop: entry.last,
      frames: session.stackFrames(),
      locals: session.stackFrames().map((frame) => ({
        frameId: frame.id,
        variables: session.variables(frame.id)
      })),
      output: session.output(),
      breakpoints: session.breakpointLines().map((line) => ({ verified: true, line })),
      finished: session.finished()
    })
  }

  function startSession(request: VmDebugRequest): void {
    const { vm, errors } = prepare(request.source, request.relativePath)

    if (vm === null) {
      for (const error of errors) {
        post({ type: 'output', runId: request.runId, stream: 'stderr', text: `${error}\n` })
      }
      post({ type: 'exit', runId: request.runId, code: 2, steps: 0 })
      return
    }

    const session = createDebugSession(vm, request.relativePath)
    session.setBreakpoints(request.breakpoints)

    /*
     * Paused at the first instruction, before running anything. `stopOnEntry` is
     * DAP's own default for a reason: a debugger that started running would race
     * the UI that was about to set a breakpoint.
     */
    const entry = { session, last: { reason: 'entry', line: session.currentLine(), message: null } as DebugStop }
    sessions.set(request.runId, entry)
    report(request.runId, entry)
  }

  function runCommand(request: VmCommandRequest): void {
    const entry = sessions.get(request.runId)
    if (entry === undefined) return

    const { session } = entry
    switch (request.command) {
      case 'continue':
        entry.last = session.continue_()
        break
      case 'stepInto':
        entry.last = session.stepInto()
        break
      case 'stepOver':
        entry.last = session.stepOver()
        break
      case 'stepOut':
        entry.last = session.stepOut()
        break
      case 'stepBack':
        entry.last = session.stepBack()
        break
      case 'reverseContinue':
        entry.last = session.reverseContinue()
        break
    }

    /*
     * A finished session is NOT a closed one. The program having ended is the
     * most interesting moment to step backwards from — "why did it print that"
     * is asked after the fact — so reaching the end reports `finished` and keeps
     * the session alive. Only `cancel` ends it, which is what DAP's `terminate`
     * means too.
     */
    report(request.runId, entry)
  }

  function rearm(request: VmBreakpointsRequest): void {
    const entry = sessions.get(request.runId)
    if (entry === undefined) return

    const resolved = entry.session.setBreakpoints(request.lines)

    /*
     * The resolved list, not the armed lines: a breakpoint the user put on a
     * comment moved, and one past the last statement could not be set at all.
     * `report` cannot say either, so this message is sent by hand — the UI has
     * to be able to move or grey out the dot.
     */
    post({
      type: 'stopped',
      runId: request.runId,
      stop: entry.last,
      frames: entry.session.stackFrames(),
      locals: entry.session.stackFrames().map((frame) => ({
        frameId: frame.id,
        variables: entry.session.variables(frame.id)
      })),
      output: entry.session.output(),
      breakpoints: resolved,
      finished: entry.session.finished()
    })
  }

  function endSession(runId: string): void {
    if (!sessions.delete(runId)) return
    post({ type: 'exit', runId, code: 130, steps: 0 })
  }

  /* ------------------------------- running ------------------------------ */

  async function execute(request: VmRunRequest): Promise<void> {
    const { vm, errors } = prepare(request.source, request.relativePath)

    if (vm === null) {
      for (const error of errors) {
        post({ type: 'output', runId: request.runId, stream: 'stderr', text: `${error}\n` })
      }
      post({ type: 'exit', runId: request.runId, code: 2, steps: 0 })
      return
    }

    let drained = 0

    const drain = (): void => {
      const pending = vm.output().slice(drained)
      drained += pending.length
      if (pending.length === 0) return
      post({
        type: 'output',
        runId: request.runId,
        stream: 'stdout',
        text: pending.map((entry) => `${entry.text}\n`).join('')
      })
    }

    for (;;) {
      if (cancelled === request.runId) {
        drain()
        post({ type: 'exit', runId: request.runId, code: 130, steps: vm.stepCount() })
        return
      }

      let running = true
      for (let index = 0; index < SLICE_STEPS && running; index++) running = vm.step()

      drain()
      if (!running) break

      // Yield, so a cancel posted while this slice ran is delivered.
      await new Promise<void>((settle) => setImmediate(settle))
    }

    const failure = vm.error()
    if (failure !== null) {
      post({
        type: 'output',
        runId: request.runId,
        stream: 'stderr',
        text: `${request.relativePath}:${failure.span.startLine}:${failure.span.startColumn} ${failure.message}\n`
      })
    }

    post({
      type: 'exit',
      runId: request.runId,
      code: failure === null ? 0 : 1,
      steps: vm.stepCount()
    })
  }
}
