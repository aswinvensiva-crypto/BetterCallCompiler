import type { BinaryOp, UnaryOp } from './ast'
import type { Span } from './token'
import { describeType, type Type } from './type-check'

/**
 * BCC's intermediate representation.
 *
 * The first thing in this repository that is a compiler rather than an editor
 * feature. Functions of basic blocks; each block a straight line of
 * instructions ending in exactly one terminator; each instruction naming its
 * operands and defining at most one result.
 *
 * ## Why not `code-graph.ts`
 *
 * That module looks like the missing piece and is not. Its nodes are source
 * CONSTRUCTS — `if`, `for`, `try` — where these are OPERATIONS. It has no
 * operands, no defs, no uses and no types on its edges, and it deliberately
 * omits merge nodes because "a join node the source does not contain is one
 * more box to read". Correct for a diagram a human reads; fatal for dataflow,
 * where the join is exactly where a phi has to go. Nothing here is reused from
 * it, and the two answer different questions.
 *
 * ## Locals live in memory, on purpose
 *
 * Every `let` and every parameter becomes an `alloca`, and reading one is a
 * `load`. That is deliberately naive — it is what LLVM emits at `-O0` — and it
 * is what makes the rest of the plan legible. Values produced by instructions
 * are already single-assignment, so the hard part of SSA is only ever about
 * *variables*, and Part 8's mem2reg has one visible job: turn this memory
 * traffic into phi nodes. A reader watches that happen instead of being told it
 * already did.
 *
 * ## One terminator per block is a type, not a check
 *
 * `terminator` is its own field rather than the last element of
 * `instructions`, so a block with two terminators or none cannot be
 * constructed. The plan asks for that invariant to be checked on every
 * lowering; making it unrepresentable is strictly stronger, and the tests spend
 * their effort on the invariant that a type cannot express — one definition per
 * value — and on the CFG actually having the shape the source implies.
 *
 * ## Spans are carried, not derived
 *
 * Every instruction and every terminator knows the source it came from. In
 * Part 9 that mapping IS the debug info: a breakpoint is a span looked up to an
 * instruction index. It is why spans were threaded from the lexer onwards, and
 * a stage that dropped them could not invent them again.
 */

/** `%0`, `%1`, … Unique within a function, and defined exactly once. */
export type ValueId = number

/**
 * A block's identity within a function.
 *
 * Lowering numbers them contiguously from zero and the entry is always 0, so
 * they happen to line up with array positions — but nothing may RELY on that.
 * `predecessorsOf`, `reachableBlocks` and `printFunction` all look blocks up by
 * id rather than indexing, so a Part 8 pass that deletes a block does not have
 * to renumber the world to stay correct.
 *
 * The doc comment here used to say "index into `blocks`", which was a promise
 * no code kept and the verifier did not check. Saying what is true is cheaper
 * than enforcing what was not.
 */
export type BlockId = number

/**
 * What an instruction reads.
 *
 * Constants are operands rather than instructions that produce a value. It
 * makes `%6 = add %4, 1` read the way a person would write it, and it makes
 * constant folding in Part 8 a rewrite of operands rather than a graph edit.
 * The cost is that dataflow has to filter operands for the value ones, which
 * `usesOf` does in one place.
 */
export type Operand =
  | { readonly kind: 'value'; readonly id: ValueId }
  | { readonly kind: 'const'; readonly value: number | boolean }

export const value = (id: ValueId): Operand => ({ kind: 'value', id })
export const constant = (v: number | boolean): Operand => ({ kind: 'const', value: v })

/**
 * A slot in the frame, named after the variable it holds.
 *
 * The name is carried for the Observatory and for the debugger's locals view in
 * Part 10 — without it a frame is a row of anonymous numbers.
 */
export interface Alloca {
  readonly op: 'alloca'
  readonly result: ValueId
  readonly name: string
  readonly type: Type
  readonly span: Span
}

export interface Load {
  readonly op: 'load'
  readonly result: ValueId
  readonly slot: ValueId
  readonly span: Span
}

/** The one instruction with no result. */
export interface Store {
  readonly op: 'store'
  readonly slot: ValueId
  readonly value: Operand
  readonly span: Span
}

export interface BinaryInstruction {
  readonly op: 'binary'
  readonly result: ValueId
  readonly operator: BinaryOp
  readonly left: Operand
  readonly right: Operand
  readonly span: Span
}

export interface UnaryInstruction {
  readonly op: 'unary'
  readonly result: ValueId
  readonly operator: UnaryOp
  readonly operand: Operand
  readonly span: Span
}

/**
 * A direct call. There is no indirect form, because BCC has no function values
 * — a rule the type checker enforces so that lowering never has to ask.
 */
export interface Call {
  readonly op: 'call'
  /** Null when the callee returns unit: nothing to name. */
  readonly result: ValueId | null
  readonly callee: string
  readonly args: readonly Operand[]
  readonly span: Span
}

/**
 * A value that depends on which way control arrived.
 *
 * Inserted by Part 6 where two definitions of the same variable meet. It is not
 * an operation the machine performs — nothing computes a phi — it is a
 * statement about the graph: "this value is whichever of these came in". Part 9
 * makes that real by arranging the predecessors to leave the right value behind
 * before they jump.
 *
 * `incoming` runs PARALLEL to `predecessorsOf(fn).get(block)`: one entry per
 * incoming EDGE, in the same order. Keeping it positional rather than keyed by
 * block is what makes `branch %c, join, join` work — two edges from one
 * predecessor need two arguments, and a map would silently hold one.
 *
 * Phis appear only at the start of a block, before any other instruction. They
 * all take effect on entry, simultaneously, so ordering them against ordinary
 * instructions would imply a sequence that does not exist.
 */
export interface Phi {
  readonly op: 'phi'
  readonly result: ValueId
  /** The variable this came from, for the Observatory. Not part of semantics. */
  readonly name: string
  readonly incoming: readonly { readonly from: BlockId; readonly value: Operand }[]
  readonly span: Span
}

export interface Print {
  readonly op: 'print'
  readonly value: Operand
  readonly span: Span
}

export type Instruction =
  | Alloca
  | Load
  | Store
  | BinaryInstruction
  | UnaryInstruction
  | Call
  | Print
  | Phi

export interface Jump {
  readonly op: 'jump'
  readonly target: BlockId
  readonly span: Span
}

export interface Branch {
  readonly op: 'branch'
  readonly condition: Operand
  readonly ifTrue: BlockId
  readonly ifFalse: BlockId
  readonly span: Span
}

export interface Return {
  readonly op: 'return'
  readonly value: Operand | null
  readonly span: Span
}

/**
 * The end of a path that cannot be taken.
 *
 * Emitted when a function that promises a value can fall off its end — which
 * the type checker has already reported as BCC0016. The IR still has to end the
 * block with something, and `unreachable` says which of the two it is rather
 * than inventing a return value nobody wrote.
 */
export interface Unreachable {
  readonly op: 'unreachable'
  readonly span: Span
}

export type Terminator = Jump | Branch | Return | Unreachable

export interface Block {
  readonly id: BlockId
  /** `entry`, `then.1`, `while.head.2` — for reading, not for identity. */
  readonly label: string
  readonly instructions: readonly Instruction[]
  readonly terminator: Terminator
}

export interface IrParam {
  readonly name: string
  /** The incoming value. The entry block copies it into an `alloca`. */
  readonly value: ValueId
  readonly type: Type
}

export interface IrFunction {
  readonly name: string
  readonly params: readonly IrParam[]
  readonly returnType: Type
  readonly blocks: readonly Block[]
  /** Always 0, named rather than assumed so a pass cannot quietly reorder it. */
  readonly entry: BlockId
  readonly span: Span
}

export interface Module {
  readonly functions: readonly IrFunction[]
}

/* -------------------------------------------------------------------------- */
/*  Walking the graph                                                          */
/* -------------------------------------------------------------------------- */

export function successorsOf(terminator: Terminator): BlockId[] {
  switch (terminator.op) {
    case 'jump':
      return [terminator.target]
    case 'branch':
      // Both, even when they are the same block. A branch to one place twice is
      // still two edges, and Part 6 needs one phi argument per edge.
      return [terminator.ifTrue, terminator.ifFalse]
    case 'return':
    case 'unreachable':
      return []
  }
}

/**
 * Predecessors, computed rather than stored.
 *
 * A stored edge list is a second copy of the truth, and every pass in Part 8
 * that rewrites a terminator would have to remember to update it. Computing is
 * linear in the size of the function and cannot go stale. Part 6 calls this
 * once per dominance computation, not once per query.
 *
 * Duplicates are kept: a block reached twice from the same predecessor — a
 * `branch %c, join, join` — appears twice, because phi arity has to match the
 * number of incoming EDGES.
 */
export function predecessorsOf(fn: IrFunction): Map<BlockId, BlockId[]> {
  const predecessors = new Map<BlockId, BlockId[]>()
  for (const block of fn.blocks) predecessors.set(block.id, [])

  for (const block of fn.blocks) {
    for (const successor of successorsOf(block.terminator)) {
      predecessors.get(successor)?.push(block.id)
    }
  }

  return predecessors
}

/** Blocks reachable from the entry, in the order a depth-first walk finds them. */
export function reachableBlocks(fn: IrFunction): Set<BlockId> {
  const seen = new Set<BlockId>()
  const byId = new Map(fn.blocks.map((block) => [block.id, block]))
  const stack: BlockId[] = [fn.entry]

  while (stack.length > 0) {
    const id = stack.pop()
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    const block = byId.get(id)
    if (block === undefined) continue
    for (const successor of successorsOf(block.terminator)) stack.push(successor)
  }

  return seen
}

/* -------------------------------------------------------------------------- */
/*  Defs and uses                                                              */
/* -------------------------------------------------------------------------- */

/** The value an instruction defines, or null for the ones that define nothing. */
export function definitionOf(instruction: Instruction): ValueId | null {
  switch (instruction.op) {
    case 'alloca':
    case 'load':
    case 'binary':
    case 'unary':
      return instruction.result
    case 'call':
      return instruction.result
    case 'phi':
      return instruction.result
    case 'store':
    case 'print':
      return null
  }
}

/**
 * The values an instruction reads.
 *
 * A `store`'s slot counts as a use: the slot is a value produced by an
 * `alloca`, and liveness that ignored it would be free to delete the alloca out
 * from under the store.
 */
export function usesOf(instruction: Instruction): ValueId[] {
  const ids: ValueId[] = []
  const add = (operand: Operand): void => {
    if (operand.kind === 'value') ids.push(operand.id)
  }

  switch (instruction.op) {
    case 'alloca':
      break
    case 'load':
      ids.push(instruction.slot)
      break
    case 'store':
      ids.push(instruction.slot)
      add(instruction.value)
      break
    case 'binary':
      add(instruction.left)
      add(instruction.right)
      break
    case 'unary':
      add(instruction.operand)
      break
    case 'call':
      for (const argument of instruction.args) add(argument)
      break
    case 'print':
      add(instruction.value)
      break
    case 'phi':
      // The incoming values. A phi "uses" them on the EDGE rather than in its
      // own block, which is why `verify.ts` checks them against the
      // predecessor's dominance and not against this block's — but for liveness
      // and for dead-code elimination they are ordinary uses.
      for (const incoming of instruction.incoming) add(incoming.value)
      break
    default:
      // Unlike the switches above, this one is statement-shaped, so TypeScript
      // does not require it to be exhaustive — a new instruction would compile
      // and silently report no uses at all, which reads to every later pass as
      // "safe to delete". This makes that a compile error instead.
      neverHappens(instruction)
  }

  return ids
}

function neverHappens(instruction: never): never {
  throw new Error(`unhandled instruction: ${JSON.stringify(instruction)}`)
}

export function terminatorUses(terminator: Terminator): ValueId[] {
  switch (terminator.op) {
    case 'branch':
      return terminator.condition.kind === 'value' ? [terminator.condition.id] : []
    case 'return':
      return terminator.value?.kind === 'value' ? [terminator.value.id] : []
    case 'jump':
    case 'unreachable':
      return []
  }
}

/* -------------------------------------------------------------------------- */
/*  Printing                                                                   */
/* -------------------------------------------------------------------------- */

export function printOperand(operand: Operand): string {
  return operand.kind === 'value' ? `%${operand.id}` : String(operand.value)
}

export function printInstruction(instruction: Instruction, labelOf: (id: BlockId) => string): string {
  switch (instruction.op) {
    case 'alloca':
      return `%${instruction.result} = alloca ${instruction.name}: ${describeType(instruction.type)}`
    case 'load':
      return `%${instruction.result} = load %${instruction.slot}`
    case 'store':
      return `store %${instruction.slot}, ${printOperand(instruction.value)}`
    case 'binary':
      return `%${instruction.result} = ${instruction.operator} ${printOperand(instruction.left)}, ${printOperand(instruction.right)}`
    case 'unary':
      return `%${instruction.result} = ${instruction.operator} ${printOperand(instruction.operand)}`
    case 'call': {
      const args = instruction.args.map(printOperand).join(', ')
      const call = `call ${instruction.callee}(${args})`
      return instruction.result === null ? call : `%${instruction.result} = ${call}`
    }
    case 'print':
      return `print ${printOperand(instruction.value)}`
    case 'phi': {
      const arms = instruction.incoming
        .map((edge) => `[${labelOf(edge.from)}, ${printOperand(edge.value)}]`)
        .join(', ')
      return `%${instruction.result} = phi ${instruction.name} ${arms}`
    }
  }
}

export function printTerminator(terminator: Terminator, labelOf: (id: BlockId) => string): string {
  switch (terminator.op) {
    case 'jump':
      return `jump ${labelOf(terminator.target)}`
    case 'branch':
      return `branch ${printOperand(terminator.condition)}, ${labelOf(terminator.ifTrue)}, ${labelOf(terminator.ifFalse)}`
    case 'return':
      return terminator.value === null ? 'ret' : `ret ${printOperand(terminator.value)}`
    case 'unreachable':
      return 'unreachable'
  }
}

/**
 * The IR as text.
 *
 * Exists for three readers, which is why it is worth getting right rather than
 * dumping JSON: the Observatory shows it, Part 8 diffs two of them to show what
 * a pass changed, and the golden tests compare against it. A format that reads
 * badly makes all three worse at once.
 */
export function printFunction(fn: IrFunction): string {
  const labelOf = (id: BlockId): string =>
    fn.blocks.find((block) => block.id === id)?.label ?? `^${id}`

  const signature = fn.params
    .map((param) => `%${param.value}: ${describeType(param.type)}`)
    .join(', ')

  const lines = [`fn ${fn.name}(${signature}) -> ${describeType(fn.returnType)} {`]

  for (const block of fn.blocks) {
    lines.push(`${block.label}:`)
    for (const instruction of block.instructions) {
      lines.push(`  ${printInstruction(instruction, labelOf)}`)
    }
    lines.push(`  ${printTerminator(block.terminator, labelOf)}`)
  }

  lines.push('}')
  return lines.join('\n')
}

export function printModule(module: Module): string {
  return module.functions.map(printFunction).join('\n\n')
}
