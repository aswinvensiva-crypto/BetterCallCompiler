import { binaryName, type CompiledFunction, type Instr, type Program } from './bytecode'
import type { Span } from './token'

/**
 * The virtual machine, built to run backwards.
 *
 * `instruction.md` names time-travel debugging as strategic bet #2 — "we own
 * the interpreter, so evaluation steps can be snapshotted and stepped
 * backwards. Neither competitor can do this on real toolchains." A forward-only
 * VM with reverse stepping bolted on afterwards is a rewrite, so the constraint
 * is designed in here: **no instruction may mutate state without the loop being
 * able to name what it overwrote.**
 *
 * ## An undo log, not periodic snapshots
 *
 * The amendment left the choice open between an undo log and whole-frame
 * snapshots plus deterministic re-execution. This is the log, for two reasons
 * the amendment itself gives: a single step backwards — overwhelmingly the
 * common case in a debugger — is O(1) rather than a re-run from the nearest
 * checkpoint, and the log is itself inspectable, which is on-thesis for an
 * editor whose whole pitch is showing you what the machine did.
 *
 * The cost is memory per step rather than memory per checkpoint, which is why
 * the bound below is not optional.
 *
 * ## Effects are recorded, never only performed
 *
 * `print` appends to a list and the host reads that list. If printing wrote
 * straight to stdout, stepping backwards over a print and forwards again would
 * print twice — the output would be a function of how you navigated rather than
 * of what the program did. So output is state, and un-printing is dropping the
 * last entry.
 *
 * ## The trace is bounded, and the policy is stated
 *
 * An unbounded log on a hot loop is a memory leak that only shows up in the
 * demo. The bound is on RECORDED STEPS, not on execution: past the limit the
 * program keeps running at full speed and the oldest history is dropped, so a
 * long program still finishes and you can still step back through its recent
 * past. Stepping back past the horizon reports that it is gone rather than
 * reconstructing something wrong.
 */

/* -------------------------------------------------------------------------- */
/*  Limits                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * How many steps of history to keep.
 *
 * 200k undo records is a few tens of megabytes at worst and covers every
 * teaching program by a wide margin — `fib(25)` is about 500k steps, so even
 * there the last 200k are inspectable.
 */
export const DEFAULT_HISTORY_LIMIT = 200_000

/** Instructions before a run is declared non-terminating. */
export const DEFAULT_STEP_LIMIT = 50_000_000

/** Call depth before recursion is declared runaway. */
export const DEFAULT_CALL_DEPTH_LIMIT = 4_096

/* -------------------------------------------------------------------------- */
/*  State                                                                      */
/* -------------------------------------------------------------------------- */

export type Value = number | boolean

export interface Frame {
  readonly fn: CompiledFunction
  /** Index of the next instruction. */
  pc: number
  readonly slots: Value[]
  /** Stack height when this frame was entered, so a return can restore it. */
  readonly stackBase: number
  /** Where the caller's pc was, for the call stack view. */
  readonly returnSpan: Span
}

export interface OutputEntry {
  readonly text: string
  readonly span: Span
}

export type VmStatus = 'running' | 'finished' | 'error'

/* -------------------------------------------------------------------------- */
/*  Undo records                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Everything one step changed, in the form needed to put it back.
 *
 * A record per step rather than per mutation: a step touches at most one slot,
 * pushes or pops a bounded amount of stack, and appends at most one output.
 * Keeping them in one object means undoing is a single pass with no ordering
 * question between kinds of change.
 */
interface UndoRecord {
  /** The pc to restore, in the frame that was current. */
  readonly pc: number
  /** How deep the frame stack was, so a call or return can be reversed. */
  readonly frameDepth: number
  /** Values popped from the operand stack, in the order they were popped. */
  readonly popped: readonly Value[]
  /** How many values the step pushed. */
  readonly pushed: number
  /** The slot written, and what was there before. */
  readonly slot: { readonly frame: number; readonly index: number; readonly before: Value } | null
  /** Whether the step appended output. */
  readonly printed: boolean
  /** The frame a call created, kept so stepping back can drop it. */
  readonly enteredFrame: boolean
  /** The frame a return removed, kept whole so stepping back can restore it. */
  readonly exitedFrame: Frame | null
}

export interface VmError {
  readonly message: string
  readonly span: Span
}

/* -------------------------------------------------------------------------- */
/*  The machine                                                                */
/* -------------------------------------------------------------------------- */

export interface VmOptions {
  readonly historyLimit?: number
  readonly stepLimit?: number
  readonly callDepthLimit?: number
}

export interface Vm {
  status(): VmStatus
  error(): VmError | null
  /** Instructions executed, which keeps counting past the history horizon. */
  stepCount(): number
  /** The span of the instruction about to run — what a debugger highlights. */
  currentSpan(): Span | null
  /** Innermost frame first. */
  frames(): readonly Frame[]
  output(): readonly OutputEntry[]
  /** Everything printed, as one string. */
  outputText(): string
  /** One instruction. False when the program has finished or failed. */
  step(): boolean
  /** One instruction backwards. False when there is no history left. */
  stepBack(): boolean
  /** How many steps can still be undone. */
  historyDepth(): number
  /** Whether history has been dropped, so the UI can say the past is partial. */
  historyTruncated(): boolean
  /** Run to completion or to a limit. */
  run(): void
}

export function createVm(program: Program, options: VmOptions = {}): Vm {
  const historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT
  const stepLimit = options.stepLimit ?? DEFAULT_STEP_LIMIT
  const callDepthLimit = options.callDepthLimit ?? DEFAULT_CALL_DEPTH_LIMIT

  const found = program.functions.get(program.entry)
  if (found === undefined) {
    throw new Error(`the program has no function named ${program.entry}`)
  }
  // Bound to a const the closures below can see as non-nullable; TypeScript
  // discards the narrowing above once it is read inside a nested function.
  const entry: CompiledFunction = found

  const stack: Value[] = []
  const frames: Frame[] = [
    { fn: entry, pc: 0, slots: new Array<Value>(entry.slots).fill(0), stackBase: 0, returnSpan: entry.span }
  ]
  const outputs: OutputEntry[] = []
  const history: UndoRecord[] = []

  let status: VmStatus = 'running'
  let failure: VmError | null = null
  let steps = 0
  let truncated = false

  /* ------------------------------ helpers ------------------------------- */

  const top = (): Frame => frames[frames.length - 1] as Frame

  const fail = (message: string, span: Span): void => {
    status = 'error'
    failure = { message, span }
  }

  function record(entryRecord: UndoRecord): void {
    history.push(entryRecord)
    if (history.length > historyLimit) {
      // Drop the oldest, and say so. Silently keeping a partial history would
      // let the UI offer a step back that lands somewhere wrong.
      history.shift()
      truncated = true
    }
  }

  /* -------------------------------- step -------------------------------- */

  function step(): boolean {
    if (status !== 'running') return false

    if (steps >= stepLimit) {
      fail(`stopped after ${stepLimit} instructions; this program may not terminate`, currentSpan() ?? entry.span)
      return false
    }

    const frame = top()
    const instr = frame.fn.code[frame.pc]
    if (instr === undefined) {
      fail('ran off the end of a function', frame.fn.span)
      return false
    }

    const startPc = frame.pc
    /*
     * The depth BEFORE the step, which is the frame that is executing.
     *
     * Recording the depth afterwards is wrong for exactly the two instructions
     * that change it. A `return` pops its own frame, so the post-step depth
     * names the CALLER — and stepping back then restored the returning
     * function's pc into the caller, leaving both frames pointing at the wrong
     * instruction. Two property tests caught it; the symptom was `inner pc:6,
     * outer pc:5` where `inner pc:5, outer pc:6` was expected, which is the two
     * values swapped between frames.
     */
    const startDepth = frames.length
    const popped: Value[] = []
    let pushed = 0
    let slotWrite: UndoRecord['slot'] = null
    let printed = false
    let enteredFrame = false
    let exitedFrame: Frame | null = null

    const pop = (): Value => {
      const popValue = stack.pop()
      if (popValue === undefined) {
        fail('the operand stack was empty', instr.span)
        return 0
      }
      popped.push(popValue)
      return popValue
    }

    const push = (pushValue: Value): void => {
      stack.push(pushValue)
      pushed++
    }

    frame.pc++

    switch (instr.op) {
      case 'const':
        push(instr.value ?? 0)
        break

      case 'load': {
        const slotValue = frame.slots[instr.operand]
        if (slotValue === undefined) {
          fail(`slot ${instr.operand} does not exist in this frame`, instr.span)
          break
        }
        push(slotValue)
        break
      }

      case 'store': {
        const before = frame.slots[instr.operand]
        if (before === undefined) {
          fail(`slot ${instr.operand} does not exist in this frame`, instr.span)
          break
        }
        slotWrite = { frame: startDepth - 1, index: instr.operand, before }
        frame.slots[instr.operand] = pop()
        break
      }

      case 'binary': {
        // Right first: it was pushed last.
        const right = pop()
        const left = pop()
        const result = applyBinary(instr.operand, left, right, instr, fail)
        if (result === null) break
        push(result)
        break
      }

      case 'unary': {
        const operand = pop()
        if (instr.operand === 0) {
          if (typeof operand !== 'number') {
            fail('cannot negate a value that is not a number', instr.span)
            break
          }
          push(-operand)
        } else {
          if (typeof operand !== 'boolean') {
            fail('cannot invert a value that is not a bool', instr.span)
            break
          }
          push(!operand)
        }
        break
      }

      case 'print': {
        const printedValue = pop()
        // Recorded, not performed. Stepping back drops the entry; performing
        // it would make the output depend on how the user navigated.
        outputs.push({ text: String(printedValue), span: instr.span })
        printed = true
        break
      }

      case 'pop':
        pop()
        break

      case 'jump':
        frame.pc = instr.operand
        break

      case 'jumpUnless': {
        const condition = pop()
        if (typeof condition !== 'boolean') {
          fail('a branch condition was not a bool', instr.span)
          break
        }
        if (!condition) frame.pc = instr.operand
        break
      }

      case 'call': {
        const callee = program.functions.get(instr.callee ?? '')
        if (callee === undefined) {
          fail(`there is no function named ${instr.callee ?? '?'}`, instr.span)
          break
        }
        if (frames.length >= callDepthLimit) {
          fail(`call depth exceeded ${callDepthLimit}; this looks like runaway recursion`, instr.span)
          break
        }

        const args: Value[] = []
        for (let index = 0; index < instr.operand; index++) args.unshift(pop())

        const slots = new Array<Value>(callee.slots).fill(0)
        // Parameters occupy slots 0..n-1, in order. `assignSlots` guarantees
        // it, and this is the code that relies on it.
        args.forEach((argument, index) => {
          slots[index] = argument
        })

        frames.push({
          fn: callee,
          pc: 0,
          slots,
          stackBase: stack.length,
          returnSpan: instr.span
        })
        enteredFrame = true
        break
      }

      case 'return':
      case 'returnUnit': {
        const result: Value = instr.op === 'return' ? pop() : 0

        if (frames.length === 1) {
          status = 'finished'
          record({
            pc: startPc,
            frameDepth: startDepth,
            popped,
            pushed,
            slot: null,
            printed: false,
            enteredFrame: false,
            exitedFrame: null
          })
          steps++
          return false
        }

        exitedFrame = frames.pop() as Frame
        // Every call site expects exactly one value back, and the compiler
        // emits `pop` where nobody wanted it — so pushing unconditionally
        // keeps the stack balanced whatever the callee's return type.
        stack.push(result)
        pushed++
        break
      }

      case 'unreachable':
        fail('reached code the type checker proved cannot run', instr.span)
        break
    }

    record({
      pc: startPc,
      frameDepth: startDepth,
      popped,
      pushed,
      slot: slotWrite,
      printed,
      enteredFrame,
      exitedFrame
    })
    steps++

    return status === 'running'
  }

  /* ------------------------------ step back ----------------------------- */

  function stepBack(): boolean {
    const undo = history.pop()
    if (undo === undefined) return false

    /*
     * Undone in the reverse of the order they were done: the stack first,
     * because a call's arguments were popped before the frame was pushed and
     * have to go back after it is removed.
     */
    if (undo.enteredFrame) frames.pop()
    if (undo.exitedFrame !== null) frames.push(undo.exitedFrame)

    for (let index = 0; index < undo.pushed; index++) stack.pop()
    // `popped` is in pop order, so it goes back in reverse.
    for (let index = undo.popped.length - 1; index >= 0; index--) {
      stack.push(undo.popped[index] as Value)
    }

    if (undo.slot !== null) {
      const frame = frames[undo.slot.frame]
      if (frame !== undefined) frame.slots[undo.slot.index] = undo.slot.before
    }

    if (undo.printed) outputs.pop()

    // `frameDepth` is the depth the step STARTED at, so this is the frame that
    // was executing — the caller for a call, the callee for a return.
    const frame = frames[undo.frameDepth - 1] ?? top()
    frame.pc = undo.pc

    // A step back always leaves the machine runnable again, including after
    // the step that finished or failed it.
    status = 'running'
    failure = null
    steps--

    return true
  }

  /* --------------------------------- api -------------------------------- */

  function currentSpan(): Span | null {
    if (frames.length === 0) return null
    const frame = top()
    return frame.fn.code[frame.pc]?.span ?? null
  }

  return {
    status: () => status,
    error: () => failure,
    stepCount: () => steps,
    currentSpan,
    frames: () => [...frames].reverse(),
    output: () => outputs,
    outputText: () => outputs.map((out) => `${out.text}\n`).join(''),
    step,
    stepBack,
    historyDepth: () => history.length,
    historyTruncated: () => truncated,
    run() {
      while (step()) {
        // `step` reports when to stop.
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Arithmetic                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Binary operators, and the one place division by zero is decided.
 *
 * Part 8's constant folder deliberately refused to fold `1 / 0`, saying the VM
 * would choose once for both spellings. This is that choice: a trap with a
 * span, so `1 / 0` and `1 / x` where `x` is zero behave identically. Folding it
 * at compile time would have made them differ.
 */
function applyBinary(
  code: number,
  left: Value,
  right: Value,
  instr: Instr,
  fail: (message: string, span: Span) => void
): Value | null {
  const numeric = typeof left === 'number' && typeof right === 'number'

  switch (code) {
    case 0:
      return numeric ? left + right : mismatch()
    case 1:
      return numeric ? left - right : mismatch()
    case 2:
      return numeric ? left * right : mismatch()
    case 3:
      if (!numeric) return mismatch()
      if (right === 0) {
        fail('division by zero', instr.span)
        return null
      }
      // Truncating, because `int` is the only numeric type — the same rule the
      // folder applied, so a folded `9 / 2` and a computed one agree.
      return Math.trunc(left / right)
    case 4:
      if (!numeric) return mismatch()
      if (right === 0) {
        fail('remainder by zero', instr.span)
        return null
      }
      return left % right
    case 5:
      return left === right
    case 6:
      return left !== right
    case 7:
      return numeric ? left < right : mismatch()
    case 8:
      return numeric ? left <= right : mismatch()
    case 9:
      return numeric ? left > right : mismatch()
    case 10:
      return numeric ? left >= right : mismatch()
    default:
      fail(`unknown operator ${code}`, instr.span)
      return null
  }

  function mismatch(): null {
    fail(`cannot apply ${binaryName(code)} to these values`, instr.span)
    return null
  }
}
