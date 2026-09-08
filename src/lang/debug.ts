import type { CompiledFunction, Program } from './bytecode'
import type { Vm } from './vm'

/**
 * The debugger: line-granular control over an instruction-granular machine.
 *
 * Everything here is a loop around `vm.step()` and `vm.stepBack()`. That is the
 * whole point of Part 9's amendment — because the VM can go backwards, "step
 * back over a loop iteration" is the same three lines as "step forward", rather
 * than a re-run from a checkpoint or an impossibility.
 *
 * ## DAP's nouns, not its wire format
 *
 * The plan commits to `threads`, `stackFrames`, `scopes`, `variables`,
 * `setBreakpoints`, `stepBack` and `reverseContinue` while explicitly not
 * implementing the wire protocol. Workstream D then built a real DAP client for
 * external adapters, and it reads the same shapes — so one debugger UI can
 * drive an external debugger and this VM without knowing which it has. That is
 * the payoff the vocabulary was chosen for, and it is why the types below are
 * imported from `dap-protocol.ts` rather than reinvented.
 *
 * ## A step is a LINE, not an instruction
 *
 * A user pressing Step expects to move a line. One `let x = a + b;` is half a
 * dozen instructions, and a debugger that stopped at each would be unusable.
 * So every stepping command runs the VM until the source LINE changes, with a
 * different rule per command about which frames count:
 *
 *   - **into**: any line change, in any frame — including one a call entered.
 *   - **over**: a line change in this frame or a shallower one. A call runs to
 *     completion without stopping inside it.
 *   - **out**: no line rule at all; run until the frame is gone.
 *
 * Getting "over" wrong is the classic debugger bug: stopping inside a callee
 * because its first instruction has a different line. The depth check is what
 * prevents it, and it is why `stepOver` compares against the depth it started
 * at rather than simply looking for a new line.
 *
 * ## Every command respects breakpoints
 *
 * Stepping over a call that hits a breakpoint stops there. A debugger that
 * ignored breakpoints during a step would run past the thing the user set it
 * to catch, which is the one moment they were waiting for.
 */

import type { DapBreakpoint, DapScope, DapStackFrame, DapVariable } from '../shared/dap-protocol'

/* -------------------------------------------------------------------------- */
/*  Stopping                                                                   */
/* -------------------------------------------------------------------------- */

export type StopReason =
  | 'entry'
  | 'breakpoint'
  | 'step'
  | 'pause'
  | 'exception'
  | 'exited'
  /** Ran backwards to the beginning; there is no earlier state. */
  | 'start'

export interface DebugStop {
  readonly reason: StopReason
  /** The line the machine is about to execute, or null when it has ended. */
  readonly line: number | null
  /** Set when `reason` is `exception`. */
  readonly message: string | null
}

/**
 * A bound on how far one command may run.
 *
 * Continue on a program with no breakpoints runs to completion, which the VM's
 * own step limit already bounds. This bounds a STEP: a step over a call to
 * something that never returns must give the UI back its thread rather than
 * appearing to hang, and reporting "still running" is a better answer than a
 * frozen window.
 */
export const MAX_STEP_INSTRUCTIONS = 5_000_000

/* -------------------------------------------------------------------------- */
/*  Session                                                                    */
/* -------------------------------------------------------------------------- */

export interface DebugSession {
  /** Resolve source lines to instructions, reporting what could be set. */
  setBreakpoints(lines: readonly number[]): DapBreakpoint[]
  breakpointLines(): readonly number[]

  /** Where execution is, without moving it. */
  currentLine(): number | null
  stackFrames(): DapStackFrame[]
  scopes(frameId: number): DapScope[]
  variables(reference: number): DapVariable[]

  continue_(): DebugStop
  stepInto(): DebugStop
  stepOver(): DebugStop
  stepOut(): DebugStop
  /** One line backwards. The capability no incumbent has on a real toolchain. */
  stepBack(): DebugStop
  /** Backwards to the previous breakpoint, or to the start. */
  reverseContinue(): DebugStop

  output(): string
  finished(): boolean
}

export function createDebugSession(vm: Vm, sourcePath: string): DebugSession {
  const program: Program = vm.program()

  /**
   * Lines that have a breakpoint, and the instruction indices they resolve to.
   *
   * Keyed by line rather than by index because the user sets breakpoints on
   * lines, and one line is many instructions — the whole set has to be
   * recognised or the breakpoint only fires when execution happens to arrive at
   * the first of them.
   */
  const armed = new Set<number>()

  /**
   * The armed line the session is currently halted on, if any.
   *
   * This is what stops a breakpoint re-firing the instant you resume: one
   * source line is several instructions, so after stopping the machine is still
   * ON that line. The first version suppressed by "the line this command
   * started from" instead, which is subtly different and wrong — `<main>` in a
   * program whose earlier lines fold away STARTS on the line the user set a
   * breakpoint on, and the breakpoint then never fired at all. Both bugs were
   * found by driving real programs.
   */
  let haltedAt: number | null = null

  /* ---------------------------- breakpoints ----------------------------- */

  /**
   * Every line any instruction in the program starts on.
   *
   * A breakpoint on a blank line, a comment or a closing brace cannot be set.
   * Reporting it as verified anyway is the single most common way a debugger
   * lies — the user watches execution run past a solid red dot — so this is
   * what `verified` is computed from, and it is the same rule the DAP client
   * applies to an external adapter's answer.
   */
  const executableLines = ((): Set<number> => {
    const lines = new Set<number>()
    for (const fn of program.functions.values()) {
      for (const instr of fn.code) lines.add(instr.span.startLine)
    }
    return lines
  })()

  function setBreakpoints(lines: readonly number[]): DapBreakpoint[] {
    armed.clear()

    return lines.map((line) => {
      if (executableLines.has(line)) {
        armed.add(line)
        return { verified: true, line }
      }

      /*
       * Move it to the next line that has code, the way every editor does —
       * clicking beside a comment should still give you a breakpoint. The
       * response says where it went, so the UI can move the dot rather than
       * leave it somewhere execution will never reach.
       */
      const moved = [...executableLines].filter((candidate) => candidate > line).sort((a, b) => a - b)[0]
      if (moved === undefined) {
        return { verified: false, line, message: 'there is no code on or after this line' }
      }

      armed.add(moved)
      return { verified: false, line: moved, message: `moved to line ${moved}` }
    })
  }

  /* ------------------------------ position ------------------------------ */

  const currentLine = (): number | null => vm.currentSpan()?.startLine ?? null

  const atBreakpoint = (): boolean => {
    const line = currentLine()
    return line !== null && armed.has(line)
  }

  const finished = (): boolean => vm.status() !== 'running'

  /**
   * Stop, and remember whether we are parked on an armed line.
   *
   * One place, so every command agrees. A step that happens to land on a
   * breakpoint records it too — otherwise the next Continue would report the
   * line the user is already looking at.
   */
  function halt(reason: StopReason): DebugStop {
    haltedAt = atBreakpoint() ? currentLine() : null
    return stopped(reason)
  }

  function stopped(reason: StopReason): DebugStop {
    if (vm.status() === 'error') {
      return { reason: 'exception', line: currentLine(), message: vm.error()?.message ?? 'failed' }
    }
    if (vm.status() === 'finished') return { reason: 'exited', line: null, message: null }
    return { reason, line: currentLine(), message: null }
  }

  /* ------------------------------ stepping ------------------------------ */

  /**
   * Run forward until `done` says to stop, a breakpoint is hit, or the program
   * ends.
   *
   * ## Breakpoints do not re-fire on the line you resumed from
   *
   * One source line is several instructions, so after stopping at a breakpoint
   * the machine is still ON that line. Checking breakpoints immediately means
   * Continue advances one instruction and stops again at the same place — the
   * debugger appears frozen while quietly making progress, which is worse than
   * either. Found by driving `loop.bcc`: two Continues in a row both reported
   * line 10 with `i` still 0.
   *
   * So a breakpoint arms only once execution has LEFT the starting line. A loop
   * that comes back to that line hits it again, which is what a breakpoint in a
   * loop is for.
   */
  function advance(done: () => boolean): DebugStop {
    // Already sitting on an armed line we did not just halt at — an arrival,
    // not a resume. This is the case a program starting on a breakpoint line
    // hits, and the case the first version dropped.
    if (atBreakpoint() && haltedAt !== currentLine()) return halt('breakpoint')

    const resumedFrom = currentLine()
    let left = false

    for (let executed = 0; executed < MAX_STEP_INSTRUCTIONS; executed++) {
      if (!vm.step()) return halt('step')
      if (currentLine() !== resumedFrom) left = true
      if (left && atBreakpoint()) return halt('breakpoint')
      if (done()) return halt('step')
    }

    // The bound. Better than a frozen window, and honest about what happened.
    haltedAt = null
    return { reason: 'pause', line: currentLine(), message: 'stopped after a very long step' }
  }

  const depth = (): number => vm.frames().length

  function stepInto(): DebugStop {
    if (finished()) return stopped('exited')
    const from = currentLine()
    return advance(() => currentLine() !== from)
  }

  function stepOver(): DebugStop {
    if (finished()) return stopped('exited')
    const from = currentLine()
    const startDepth = depth()

    /*
     * A line change is only a stop if we are not deeper than we started. The
     * depth check is what makes this "over" rather than "into" — without it,
     * the first instruction of a callee has a different line and the debugger
     * stops inside the call the user asked to step over.
     */
    return advance(() => depth() <= startDepth && currentLine() !== from)
  }

  function stepOut(): DebugStop {
    if (finished()) return stopped('exited')
    const startDepth = depth()
    if (startDepth <= 1) {
      // Nothing to return to; run on like Continue rather than doing nothing.
      return continue_()
    }
    return advance(() => depth() < startDepth)
  }

  function continue_(): DebugStop {
    if (finished()) return stopped('exited')
    return advance(() => false)
  }

  /* --------------------------- going backwards -------------------------- */

  /**
   * Run backwards until `done`, a breakpoint, or the beginning.
   *
   * The mirror of `advance`, and it is only this short because Part 9 made the
   * VM reversible. Without that this would be "re-run from the start and stop
   * one step earlier", which is quadratic and visibly slow on a loop.
   */
  function retreat(done: () => boolean): DebugStop {
    const resumedFrom = currentLine()
    let left = false

    for (let undone = 0; undone < MAX_STEP_INSTRUCTIONS; undone++) {
      if (!vm.stepBack()) {
        // Either the program's beginning, or the horizon of a truncated log.
        return {
          reason: 'start',
          line: currentLine(),
          message: vm.historyTruncated() ? 'no further history was kept' : null
        }
      }
      if (currentLine() !== resumedFrom) left = true
      if (left && atBreakpoint()) return stopped('breakpoint')
      if (done()) return stopped('step')
    }

    return { reason: 'pause', line: currentLine(), message: 'stopped after a very long step' }
  }

  function stepBack(): DebugStop {
    const from = currentLine()
    const startDepth = depth()
    // The same "over" rule in reverse: coming back out of a call should not
    // stop inside it.
    return retreat(() => depth() <= startDepth && currentLine() !== from)
  }

  function reverseContinue(): DebugStop {
    return retreat(() => false)
  }

  /* ------------------------------- inspect ------------------------------ */

  /**
   * Frames, innermost first, with ids the UI can hand back.
   *
   * The id is the DEPTH, not an index into the array: the array is reversed for
   * display, and a caller that stored an index would read the wrong frame after
   * one step changed the stack. Depth is stable for as long as the frame is.
   */
  function stackFrames(): DapStackFrame[] {
    /*
     * A program that RETURNED has no stack. The VM keeps its outermost frame
     * after `<main>` returns — it has nowhere to put it — and that frame's pc is
     * then past the last instruction, so the line fallback below would report
     * the function's own span. `<main>`'s span is the whole file, so the UI
     * highlighted line 1, which in every example is a comment.
     *
     * Deliberately `finished` and not `!== 'running'`: a program that TRAPPED
     * keeps its stack, because where it broke is the thing the user opened the
     * debugger to see.
     */
    if (vm.status() === 'finished') return []

    return vm.frames().map((frame, index) => {
      const line = frame.fn.code[frame.pc]?.span.startLine ?? frame.fn.span.startLine
      return {
        id: vm.frames().length - index,
        name: frame.fn.name,
        source: { name: sourcePath, path: sourcePath },
        line,
        column: frame.fn.code[frame.pc]?.span.startColumn ?? 1
      }
    })
  }

  /**
   * One scope per frame — locals.
   *
   * BCC has no globals and no closures, so a second scope would be an empty box
   * on screen. The `variablesReference` encodes the frame, which is all the
   * indirection needed when there is nothing nested to expand.
   */
  function scopes(frameId: number): DapScope[] {
    return [{ name: 'Locals', variablesReference: frameId, expensive: false }]
  }

  function variables(reference: number): DapVariable[] {
    // Same rule as `stackFrames`, so a locals pane cannot outlive the frame it
    // belongs to: the UI asks for both and would otherwise get an empty stack
    // beside a full set of values.
    if (vm.status() === 'finished') return []

    const frames = vm.frames()
    const frame = frames[frames.length - reference]
    if (frame === undefined) return []

    const fn: CompiledFunction = frame.fn

    return frame.slots.flatMap((value, index) => {
      const name = fn.slotNames[index]
      // Unnamed slots are compiler temporaries. Showing `%4 = 17` in a locals
      // pane is noise for a user and a lie for a teacher — the variable it came
      // from is what they are looking for, and it is not recoverable here.
      if (name === null || name === undefined) return []

      return [
        {
          name,
          value: String(value),
          type: typeof value === 'boolean' ? 'bool' : 'int',
          variablesReference: 0
        }
      ]
    })
  }

  return {
    setBreakpoints,
    breakpointLines: () => [...armed].sort((a, b) => a - b),
    currentLine,
    stackFrames,
    scopes,
    variables,
    continue_,
    stepInto,
    stepOver,
    stepOut,
    stepBack,
    reverseContinue,
    output: () => vm.outputText(),
    finished
  }
}
