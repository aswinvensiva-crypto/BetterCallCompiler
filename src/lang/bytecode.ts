import type { BinaryOp, UnaryOp } from './ast'
import {
  definitionOf,
  predecessorsOf,
  type BlockId,
  type IrFunction,
  type Module,
  type Operand,
  type ValueId
} from './ir'
import type { Span } from './token'

/**
 * Bytecode: the last stage before something runs.
 *
 * A stack machine, chosen over a register machine for one reason — a reader can
 * follow it. `push 1; push 2; add` is a sentence; `add r3, r1, r2` needs a
 * register allocator to have run first, and a register allocator is a
 * substantial pass whose output nobody can check by eye. The Observatory shows
 * this listing beside the SSA it came from, so being readable IS the
 * requirement.
 *
 * ## Every instruction carries a span, and that is the debug info
 *
 * There is no separate line table. `instruction.span` is the mapping, which is
 * why spans have been threaded since the lexer in Part 1: a breakpoint in
 * Part 10 is a span looked up to an instruction index, and stepping is reading
 * the span of the instruction about to run. A stage that dropped them could not
 * invent them again.
 *
 * ## Phis are resolved here, not executed
 *
 * Nothing computes a phi. `ir.ts` says so: it is "a statement about the graph".
 * Making it real is this stage's job, and the classic way is what happens
 * below — before each jump, the predecessor STORES the value that block's phis
 * expect into the slots those phis own. The phi itself compiles to nothing.
 *
 * The subtlety is that the stores have to appear parallel even though they run
 * in sequence. `%1 = phi [a, %2]` and `%2 = phi [a, %1]` in the same block is a
 * swap, and doing it naively assigns one before reading the other. Real
 * compilers break the cycle with a temporary; this one detects the case and
 * refuses rather than emitting something wrong, because `toSsa` cannot
 * currently produce it and a wrong answer here is a wrong program.
 *
 * ## Values are slots, not stack positions
 *
 * Every SSA value gets a frame slot, and instructions load from and store to
 * them. A pure stack discipline would need the compiler to track stack depth
 * through every branch and join — the thing that makes stack-machine backends
 * fiddly — and buys nothing here, since the VM's frame is an array either way.
 * The stack is used for the width of one instruction: push operands, apply,
 * store the result.
 */

/* -------------------------------------------------------------------------- */
/*  The instruction set                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Deliberately small. Sixteen opcodes cover the whole language, and every one
 * of them is something a reader can simulate in their head.
 */
export type Op =
  /** Push a literal. */
  | 'const'
  /** Push the value in a slot. */
  | 'load'
  /** Pop, and store into a slot. */
  | 'store'
  /** Pop two, push the result. */
  | 'binary'
  /** Pop one, push the result. */
  | 'unary'
  /** Pop and print. Recorded as an effect, never only performed. */
  | 'print'
  /** Unconditional. */
  | 'jump'
  /** Pop a bool; jump when it is false. */
  | 'jumpUnless'
  /** Push arguments left to right, then call. */
  | 'call'
  /** Return with the top of stack. */
  | 'return'
  /** Return no value. */
  | 'returnUnit'
  /** The end of a path the type checker proved cannot be taken. */
  | 'unreachable'
  /** Discard the top of stack — a call whose result nobody named. */
  | 'pop'

export interface Instr {
  readonly op: Op
  /**
   * What the opcode operates on. Its meaning is per-op and documented at each
   * emit site: a slot index for `load`/`store`, a target for the jumps, an
   * argument count for `call`.
   */
  readonly operand: number
  /** Only `const` and `call` need more than a number. */
  readonly value?: number | boolean
  readonly callee?: string
  /**
   * The source this came from. THE debug info — there is no line table beside
   * it, and Part 10's breakpoints are a lookup into these.
   */
  readonly span: Span
}

export interface CompiledFunction {
  readonly name: string
  /** How many parameters to pop from the caller's stack, left to right. */
  readonly arity: number
  /** Frame size. Every SSA value and every phi gets one. */
  readonly slots: number
  readonly code: readonly Instr[]
  /** Whether the function returns a value the caller should keep. */
  readonly returnsValue: boolean
  readonly span: Span
}

export interface Program {
  readonly functions: ReadonlyMap<string, CompiledFunction>
  readonly entry: string
}

/** A compile that could not proceed, with the source to point at. */
export class BytecodeError extends Error {
  constructor(
    message: string,
    readonly span: Span
  ) {
    super(message)
    this.name = 'BytecodeError'
  }
}

/* -------------------------------------------------------------------------- */
/*  Slot assignment                                                            */
/* -------------------------------------------------------------------------- */

/**
 * One slot per SSA value, including phis.
 *
 * `ValueId`s are unique within a function but not contiguous — Part 8's passes
 * delete instructions and leave gaps — so they cannot be used as indices
 * directly without over-allocating the frame to the largest id. Mapping them
 * down keeps a frame the size of what the function actually uses, which is what
 * Part 10's locals view will page through.
 */
function assignSlots(fn: IrFunction): Map<ValueId, number> {
  const slots = new Map<ValueId, number>()
  const take = (id: ValueId): void => {
    if (!slots.has(id)) slots.set(id, slots.size)
  }

  // Parameters first, and in order: the VM stores incoming arguments into
  // slots 0..n-1 without consulting this map, so the order is load-bearing.
  for (const param of fn.params) take(param.value)

  for (const block of fn.blocks) {
    for (const instruction of block.instructions) {
      const defined = definitionOf(instruction)
      if (defined !== null) take(defined)
    }
  }

  return slots
}

/* -------------------------------------------------------------------------- */
/*  Compiling one function                                                     */
/* -------------------------------------------------------------------------- */

interface Patch {
  /** Index of the jump whose operand is not known yet. */
  readonly at: number
  readonly target: BlockId
}

export function compileFunction(fn: IrFunction): CompiledFunction {
  const slots = assignSlots(fn)
  const code: Instr[] = []
  const patches: Patch[] = []
  const blockStart = new Map<BlockId, number>()
  const predecessors = predecessorsOf(fn)

  const slotOf = (id: ValueId, span: Span): number => {
    const slot = slots.get(id)
    if (slot === undefined) {
      // The verifier rejects a use with no definition, so reaching this means
      // the IR skipped verification. Failing loudly beats emitting a load from
      // slot -1 and producing a wrong number at runtime.
      throw new BytecodeError(`%${id} is used but never defined`, span)
    }
    return slot
  }

  const emit = (instr: Instr): number => code.push(instr) - 1

  const pushOperand = (operand: Operand, span: Span): void => {
    if (operand.kind === 'const') {
      emit({ op: 'const', operand: 0, value: operand.value, span })
    } else {
      emit({ op: 'load', operand: slotOf(operand.id, span), span })
    }
  }

  /**
   * The stores a jump from `from` to `to` owes `to`'s phis.
   *
   * This is where a phi becomes real. Every phi in the target names one value
   * per incoming EDGE; the edge being taken is this one, so the predecessor
   * writes that value into the phi's slot immediately before jumping.
   */
  const emitPhiStores = (from: BlockId, to: BlockId): void => {
    const target = fn.blocks.find((block) => block.id === to)
    if (target === undefined) return

    const incoming = predecessors.get(to) ?? []
    const writes: { slot: number; operand: Operand; span: Span }[] = []

    for (const instruction of target.instructions) {
      if (instruction.op !== 'phi') break // Phis are only ever at the start.

      // Positional: `incoming` runs parallel to the phi's arguments, so the
      // index of THIS edge selects the argument. A map keyed by block would
      // hold one entry for `branch %c, join, join`, which is two edges.
      const index = incoming.indexOf(from)
      const arm = index === -1 ? undefined : instruction.incoming[index]
      if (arm === undefined) {
        throw new BytecodeError(
          `%${instruction.result} has no argument for the edge from block ${from}`,
          instruction.span
        )
      }

      writes.push({ slot: slotOf(instruction.result, instruction.span), operand: arm.value, span: instruction.span })
    }

    /*
     * A phi reading a slot another phi in the same block is about to write is a
     * parallel-assignment cycle — a swap. Sequential stores get it wrong, and
     * breaking the cycle needs a temporary slot. `toSsa` does not produce this
     * shape, so refusing is honest; emitting the naive sequence would produce a
     * program that runs and is wrong, which is the worst outcome available.
     */
    const written = new Set(writes.map((write) => write.slot))
    for (const write of writes) {
      if (write.operand.kind !== 'value') continue
      const read = slots.get(write.operand.id)
      if (read !== undefined && written.has(read) && read !== write.slot) {
        throw new BytecodeError(
          'phi nodes in this block assign to each other; a temporary would be needed',
          write.span
        )
      }
    }

    for (const write of writes) {
      pushOperand(write.operand, write.span)
      emit({ op: 'store', operand: write.slot, span: write.span })
    }
  }

  const jumpTo = (from: BlockId, to: BlockId, op: 'jump' | 'jumpUnless', span: Span): void => {
    if (op === 'jumpUnless') {
      // The condition is already on the stack and must be consumed before the
      // phi stores run, or they would push on top of it.
      const at = emit({ op: 'jumpUnless', operand: -1, span })
      patches.push({ at, target: to })
      return
    }

    emitPhiStores(from, to)
    const at = emit({ op: 'jump', operand: -1, span })
    patches.push({ at, target: to })
  }

  for (const block of fn.blocks) {
    blockStart.set(block.id, code.length)

    for (const instruction of block.instructions) {
      switch (instruction.op) {
        case 'phi':
          // Compiles to nothing. Its predecessors did the work.
          break

        case 'alloca':
          /*
           * After mem2reg there are none. One surviving means the IR skipped
           * the pass, and a VM with no memory model cannot run it — so this
           * says which variable rather than failing later with a bad slot.
           */
          throw new BytecodeError(
            `'${instruction.name}' is still in memory; run mem2reg before compiling`,
            instruction.span
          )

        case 'load':
        case 'store':
          throw new BytecodeError(
            'memory access survived mem2reg; the IR is not ready to compile',
            instruction.span
          )

        case 'binary':
          pushOperand(instruction.left, instruction.span)
          pushOperand(instruction.right, instruction.span)
          emit({ op: 'binary', operand: binaryCode(instruction.operator), span: instruction.span })
          emit({ op: 'store', operand: slotOf(instruction.result, instruction.span), span: instruction.span })
          break

        case 'unary':
          pushOperand(instruction.operand, instruction.span)
          emit({ op: 'unary', operand: unaryCode(instruction.operator), span: instruction.span })
          emit({ op: 'store', operand: slotOf(instruction.result, instruction.span), span: instruction.span })
          break

        case 'print':
          pushOperand(instruction.value, instruction.span)
          emit({ op: 'print', operand: 0, span: instruction.span })
          break

        case 'call': {
          for (const argument of instruction.args) pushOperand(argument, instruction.span)
          emit({
            op: 'call',
            operand: instruction.args.length,
            callee: instruction.callee,
            span: instruction.span
          })
          if (instruction.result === null) {
            // A unit call still leaves its frame's result behind; dropping it
            // here keeps the stack balanced across the whole function.
            emit({ op: 'pop', operand: 0, span: instruction.span })
          } else {
            emit({ op: 'store', operand: slotOf(instruction.result, instruction.span), span: instruction.span })
          }
          break
        }
      }
    }

    const terminator = block.terminator
    switch (terminator.op) {
      case 'jump':
        jumpTo(block.id, terminator.target, 'jump', terminator.span)
        break

      case 'branch': {
        /*
         * Both arms may owe phi stores, and they owe DIFFERENT ones. So the
         * conditional jump goes to a stub that does the false arm's stores,
         * and the fall-through does the true arm's — rather than trying to run
         * stores before a branch that has not been decided yet.
         */
        pushOperand(terminator.condition, terminator.span)
        const at = emit({ op: 'jumpUnless', operand: -1, span: terminator.span })

        emitPhiStores(block.id, terminator.ifTrue)
        const trueJump = emit({ op: 'jump', operand: -1, span: terminator.span })
        patches.push({ at: trueJump, target: terminator.ifTrue })

        // The false arm starts here.
        code[at] = { ...(code[at] as Instr), operand: code.length }
        emitPhiStores(block.id, terminator.ifFalse)
        const falseJump = emit({ op: 'jump', operand: -1, span: terminator.span })
        patches.push({ at: falseJump, target: terminator.ifFalse })
        break
      }

      case 'return':
        if (terminator.value === null) {
          emit({ op: 'returnUnit', operand: 0, span: terminator.span })
        } else {
          pushOperand(terminator.value, terminator.span)
          emit({ op: 'return', operand: 0, span: terminator.span })
        }
        break

      case 'unreachable':
        emit({ op: 'unreachable', operand: 0, span: terminator.span })
        break
    }
  }

  for (const patch of patches) {
    const target = blockStart.get(patch.target)
    if (target === undefined) {
      throw new BytecodeError(`jump to block ${patch.target}, which does not exist`, fn.span)
    }
    code[patch.at] = { ...(code[patch.at] as Instr), operand: target }
  }

  return {
    name: fn.name,
    arity: fn.params.length,
    slots: slots.size,
    code,
    returnsValue: fn.returnType.kind !== 'unit',
    span: fn.span
  }
}

export function compileModule(module: Module, entry: string): Program {
  const functions = new Map<string, CompiledFunction>()
  for (const fn of module.functions) functions.set(fn.name, compileFunction(fn))
  return { functions, entry }
}

/* -------------------------------------------------------------------------- */
/*  Operator codes                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Operators as small integers.
 *
 * A string in the hot loop would mean a string comparison per arithmetic
 * instruction, and — more to the point for a teaching VM — a numeric opcode is
 * what real bytecode looks like. The tables are exhaustive `Record`s so a new
 * operator is a compile error rather than a runtime surprise.
 */
export const BINARY_CODES: Readonly<Record<BinaryOp, number>> = {
  '+': 0,
  '-': 1,
  '*': 2,
  '/': 3,
  '%': 4,
  '==': 5,
  '!=': 6,
  '<': 7,
  '<=': 8,
  '>': 9,
  '>=': 10
}

export const UNARY_CODES: Readonly<Record<UnaryOp, number>> = { '-': 0, '!': 1 }

const BINARY_NAMES = invert(BINARY_CODES)
const UNARY_NAMES = invert(UNARY_CODES)

function invert(codes: Readonly<Record<string, number>>): ReadonlyMap<number, string> {
  return new Map(Object.entries(codes).map(([name, code]) => [code, name]))
}

function binaryCode(operator: BinaryOp): number {
  return BINARY_CODES[operator]
}

function unaryCode(operator: UnaryOp): number {
  return UNARY_CODES[operator]
}

export function binaryName(code: number): string {
  return BINARY_NAMES.get(code) ?? `?${code}`
}

export function unaryName(code: number): string {
  return UNARY_NAMES.get(code) ?? `?${code}`
}

/* -------------------------------------------------------------------------- */
/*  Printing                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The listing, for the Observatory and the golden tests.
 *
 * Indices are shown because every jump names one; a listing without them cannot
 * be checked against a jump target by eye, which is exactly what these tests do.
 */
export function printInstruction(instr: Instr): string {
  switch (instr.op) {
    case 'const':
      return `const ${String(instr.value)}`
    case 'load':
      return `load $${instr.operand}`
    case 'store':
      return `store $${instr.operand}`
    case 'binary':
      return `binary ${binaryName(instr.operand)}`
    case 'unary':
      return `unary ${unaryName(instr.operand)}`
    case 'jump':
      return `jump ${instr.operand}`
    case 'jumpUnless':
      return `jumpUnless ${instr.operand}`
    case 'call':
      return `call ${instr.callee ?? '?'}/${instr.operand}`
    default:
      return instr.op
  }
}

export function printFunctionCode(fn: CompiledFunction): string {
  const lines = [`fn ${fn.name}/${fn.arity} slots=${fn.slots} {`]
  fn.code.forEach((instr, index) => {
    lines.push(`${String(index).padStart(4, ' ')}  ${printInstruction(instr)}`)
  })
  lines.push('}')
  return lines.join('\n')
}

export function printProgram(program: Program): string {
  return [...program.functions.values()].map(printFunctionCode).join('\n\n')
}
