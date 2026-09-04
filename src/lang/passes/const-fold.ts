import type { BinaryOp, UnaryOp } from '../ast'
import {
  constant,
  type Block,
  type Instruction,
  type IrFunction,
  type Operand,
  type Terminator,
  type ValueId
} from '../ir'
import type { Pass, PassResult } from '../pass-manager'

/**
 * Constant folding: arithmetic the compiler can do so the machine does not.
 *
 * The simplest of the four passes and the one that shows what a rewrite IS.
 * `%6 = add 1, 2` becomes the constant `3`, and every read of `%6` becomes `3`.
 *
 * ## Folding here means DELETING, not replacing
 *
 * There is no instruction that produces a constant. `ir.ts` made constants
 * OPERANDS instead — `%6 = add %4, 1` reads the way a person would write it —
 * and the consequence lands right here: a folded instruction cannot be rewritten
 * into `%6 = 3`, because no such instruction exists. It has to be removed and
 * its result substituted into every operand that read it. So this pass is a
 * fold and a substitution at once, which is why it is written before copy
 * propagation rather than after: the substitution machinery is the same, and
 * doing it twice would be the version of this a reader has to hold two copies
 * of in their head.
 *
 * ## It runs to a fixpoint
 *
 * `let a = 1 + 2; let b = a + 3;` needs two rounds: the first turns `a` into
 * `3`, and only then can `b` fold. Visiting blocks in dominator preorder would
 * catch most chains in one pass, but not all of them — a phi whose arms all
 * fold to the same constant closes a loop — and "most" is the kind of
 * almost-right that shows up as an optimisation that works in the test and not
 * in the demo. Iterating until nothing moves is a few lines, obviously correct,
 * and at BCC's scale costs nothing worth measuring.
 *
 * ## What it deliberately does not do
 *
 * It never touches a terminator's SHAPE. `branch true, a, b` could obviously
 * become `jump a`, and doing it here would strand block `b` with no path from
 * the entry — which the verifier reports as `unreachable-block`, correctly, and
 * the pipeline would refuse the pass. Removing the block that folding orphaned
 * is dead-code elimination's job, and keeping the two apart is what lets each
 * be read on its own. Operands inside a terminator are still substituted; it is
 * only the branch-to-jump rewrite that waits.
 */

/** A hard bound, so a pass that somehow oscillates cannot hang the daemon. */
const MAX_ROUNDS = 32

/* -------------------------------------------------------------------------- */
/*  Evaluating                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The constant an operation produces, or null when it must be left alone.
 *
 * Null covers three different situations on purpose, because the pass treats
 * them identically: the operands are not both constants, the operands are the
 * wrong TYPE for the operator, or the result is not something a compiler may
 * decide at compile time. Only the last one is interesting, and it is `/` and
 * `%` by zero — see below.
 */
function foldBinary(
  operator: BinaryOp,
  left: number | boolean,
  right: number | boolean
): Operand | null {
  const numeric = typeof left === 'number' && typeof right === 'number'

  switch (operator) {
    case '+':
      return numeric ? constant(left + right) : null
    case '-':
      return numeric ? constant(left - right) : null
    case '*':
      return numeric ? constant(left * right) : null
    case '/':
      /*
       * Division by zero is NOT folded, and this is the one line in the pass
       * worth arguing about.
       *
       * BCC has no VM yet, so what `1 / 0` does at runtime is undecided —
       * Part 9 will choose, and it will probably be a trap with a span. If this
       * folded it, the answer would be decided here instead, invisibly and
       * differently depending on whether the divisor happened to be a literal.
       * `let a = 1 / 0;` would produce whatever JavaScript's `Infinity` becomes
       * while `let a = 1 / x;` with `x = 0` trapped, and a language where a
       * constant and a variable holding the same value behave differently is a
       * language with a bug in it.
       *
       * Leaving it means the instruction survives to Part 9 and the VM decides
       * once, for both spellings.
       */
      return numeric && right !== 0 ? constant(Math.trunc(left / right)) : null
    case '%':
      return numeric && right !== 0 ? constant(left % right) : null
    case '<':
      return numeric ? constant(left < right) : null
    case '<=':
      return numeric ? constant(left <= right) : null
    case '>':
      return numeric ? constant(left > right) : null
    case '>=':
      return numeric ? constant(left >= right) : null
    case '==':
      // Both numbers or both booleans. `1 == true` is not something the type
      // checker permits, and folding it would invent an answer for a program
      // that should not have got this far.
      return typeof left === typeof right ? constant(left === right) : null
    case '!=':
      return typeof left === typeof right ? constant(left !== right) : null
  }
}

function foldUnary(operator: UnaryOp, operand: number | boolean): Operand | null {
  switch (operator) {
    case '-':
      return typeof operand === 'number' ? constant(-operand) : null
    case '!':
      return typeof operand === 'boolean' ? constant(!operand) : null
  }
}

/** The instruction's constant result, or null when it does not have one. */
function evaluate(instruction: Instruction): Operand | null {
  if (instruction.op === 'binary') {
    if (instruction.left.kind !== 'const' || instruction.right.kind !== 'const') return null
    return foldBinary(instruction.operator, instruction.left.value, instruction.right.value)
  }

  if (instruction.op === 'unary') {
    if (instruction.operand.kind !== 'const') return null
    return foldUnary(instruction.operator, instruction.operand.value)
  }

  /*
   * Everything else is left alone, and the omissions are deliberate rather than
   * unfinished. A `load` reads memory that a `store` may have changed — turning
   * loads into constants is mem2reg's job and needs dominance to be safe. A
   * `call` may print. A `phi` whose arms are all the same constant IS foldable,
   * but only once mem2reg has built phis worth folding, so it costs nothing to
   * leave until then.
   */
  return null
}

/* -------------------------------------------------------------------------- */
/*  Substituting                                                               */
/* -------------------------------------------------------------------------- */

type Substitution = ReadonlyMap<ValueId, Operand>

function substitute(operand: Operand, folded: Substitution): Operand {
  return operand.kind === 'value' ? (folded.get(operand.id) ?? operand) : operand
}

function rewriteInstruction(instruction: Instruction, folded: Substitution): Instruction {
  switch (instruction.op) {
    case 'binary':
      return {
        ...instruction,
        left: substitute(instruction.left, folded),
        right: substitute(instruction.right, folded)
      }
    case 'unary':
      return { ...instruction, operand: substitute(instruction.operand, folded) }
    case 'store':
      // `slot` is a ValueId rather than an Operand and is deliberately not
      // substituted: it names an `alloca`, and an alloca is never folded, so a
      // substitution there could only ever be wrong.
      return { ...instruction, value: substitute(instruction.value, folded) }
    case 'call':
      return { ...instruction, args: instruction.args.map((arg) => substitute(arg, folded)) }
    case 'print':
      return { ...instruction, value: substitute(instruction.value, folded) }
    case 'phi':
      return {
        ...instruction,
        incoming: instruction.incoming.map((edge) => ({
          ...edge,
          value: substitute(edge.value, folded)
        }))
      }
    case 'alloca':
    case 'load':
      return instruction
  }
}

function rewriteTerminator(terminator: Terminator, folded: Substitution): Terminator {
  switch (terminator.op) {
    case 'branch':
      return { ...terminator, condition: substitute(terminator.condition, folded) }
    case 'return':
      return {
        ...terminator,
        value: terminator.value === null ? null : substitute(terminator.value, folded)
      }
    case 'jump':
    case 'unreachable':
      return terminator
  }
}

/* -------------------------------------------------------------------------- */
/*  The pass                                                                   */
/* -------------------------------------------------------------------------- */

/** One round. Returns null when there was nothing to fold. */
function foldOnce(fn: IrFunction): IrFunction | null {
  const folded = new Map<ValueId, Operand>()

  for (const block of fn.blocks) {
    for (const instruction of block.instructions) {
      const result = evaluate(instruction)
      if (result === null) continue
      const definition = instruction.op === 'binary' || instruction.op === 'unary'
        ? instruction.result
        : null
      if (definition !== null) folded.set(definition, result)
    }
  }

  if (folded.size === 0) return null

  const blocks: Block[] = fn.blocks.map((block) => ({
    ...block,
    instructions: block.instructions
      // Drop the folded ones first, then rewrite what is left. Doing it in this
      // order means a folded instruction is never asked to substitute into
      // itself, which for `%1 = add 1, 2` would be harmless and for a
      // self-referential phi would not be.
      .filter((instruction) => {
        const definition =
          instruction.op === 'binary' || instruction.op === 'unary' ? instruction.result : null
        return definition === null || !folded.has(definition)
      })
      .map((instruction) => rewriteInstruction(instruction, folded)),
    terminator: rewriteTerminator(block.terminator, folded)
  }))

  return { ...fn, blocks }
}

export const constantFolding: Pass = {
  name: 'const-fold',
  summary: 'evaluates arithmetic whose operands are already known',

  run(fn: IrFunction): PassResult {
    let current = fn
    let rounds = 0
    let instructions = 0

    for (; rounds < MAX_ROUNDS; rounds++) {
      const next = foldOnce(current)
      if (next === null) break
      instructions += countInstructions(current) - countInstructions(next)
      current = next
    }

    if (rounds === 0) return { fn, notes: [] }

    const roundNote = rounds === 1 ? '' : ` over ${rounds} rounds`
    return {
      fn: current,
      notes: [`folded ${instructions} instruction${instructions === 1 ? '' : 's'}${roundNote}`]
    }
  }
}

function countInstructions(fn: IrFunction): number {
  return fn.blocks.reduce((total, block) => total + block.instructions.length, 0)
}
