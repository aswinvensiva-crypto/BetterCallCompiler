import { parentPort } from 'node:worker_threads'
import { compileModule, BytecodeError } from '../lang/bytecode'
import { lower, TOP_LEVEL_FUNCTION } from '../lang/lower'
import { runPipeline } from '../lang/pass-manager'
import { OPTIMISATION_PIPELINE } from '../lang/passes'
import { parseSource } from '../lang/parser'
import { resolve } from '../lang/symbols'
import { typeCheck } from '../lang/type-check'
import { createVm, type Vm } from '../lang/vm'

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

export type VmWorkerRequest = VmRunRequest | VmCancelRequest

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

export type VmWorkerMessage = VmOutputMessage | VmExitMessage

export function isVmWorkerRequest(value: unknown): value is VmWorkerRequest {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (typeof record['runId'] !== 'string') return false

  // Enumerated by hand, which is the one thing TypeScript does not check here —
  // the same gap `isWorkerMessage` has, and the same reason it gets a test.
  return record['type'] === 'run' || record['type'] === 'cancel'
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

  const post = (message: VmWorkerMessage): void => port.postMessage(message)

  port.on('message', (value: unknown) => {
    if (!isVmWorkerRequest(value)) return

    if (value.type === 'cancel') {
      cancelled = value.runId
      return
    }

    void execute(value)
  })

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
