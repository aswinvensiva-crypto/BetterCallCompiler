import type { Block, Instruction, Operand, Terminator, ValueId } from '../ir'

/**
 * Replacing one value with another, everywhere it is read.
 *
 * Shared because two passes need exactly this and a third is coming.
 * `const-fold` deletes an instruction and substitutes its constant; this pass's
 * sibling `copy-prop` deletes a trivial phi and substitutes its one real
 * argument; mem2reg will delete a load and substitute the value that was
 * stored. Three passes, one rewrite, and const-fold's own comment already said
 * writing it twice would be the version a reader has to hold two copies of.
 *
 * ## Slots are not substituted, and that is the whole subtlety
 *
 * `load.slot` and `store.slot` are `ValueId` rather than `Operand`, and they
 * are deliberately left alone. They name an `alloca`, and no pass substitutes
 * an alloca — a constant is not a slot, a phi result is not a slot, and a value
 * loaded out of one is not the slot itself. A substitution there could only
 * ever be wrong, so the type not being an `Operand` is the IR making that
 * unrepresentable rather than a rule someone has to remember.
 */

export type Substitution = ReadonlyMap<ValueId, Operand>

/**
 * Follow a chain of substitutions to its end.
 *
 * `%1 → %2` and `%2 → 3` has to resolve `%1` to `3`, not to `%2`. Building the
 * map so that never happens is possible and fragile; resolving on read is two
 * lines and cannot be got wrong by a caller that adds an entry in the wrong
 * order.
 *
 * The `seen` guard is not paranoia. A loop-carried phi can legitimately name
 * itself, and a cycle in the map would otherwise spin here rather than fail
 * somewhere a reader could find it.
 */
export function resolve(operand: Operand, subs: Substitution): Operand {
  let current = operand
  const seen = new Set<ValueId>()

  while (current.kind === 'value') {
    if (seen.has(current.id)) return current
    seen.add(current.id)
    const next = subs.get(current.id)
    if (next === undefined) return current
    current = next
  }

  return current
}

export function substituteInInstruction(
  instruction: Instruction,
  subs: Substitution
): Instruction {
  const of = (operand: Operand): Operand => resolve(operand, subs)

  switch (instruction.op) {
    case 'binary':
      return { ...instruction, left: of(instruction.left), right: of(instruction.right) }
    case 'unary':
      return { ...instruction, operand: of(instruction.operand) }
    case 'store':
      return { ...instruction, value: of(instruction.value) }
    case 'call':
      return { ...instruction, args: instruction.args.map(of) }
    case 'print':
      return { ...instruction, value: of(instruction.value) }
    case 'phi':
      return {
        ...instruction,
        incoming: instruction.incoming.map((edge) => ({ ...edge, value: of(edge.value) }))
      }
    case 'alloca':
    case 'load':
      // Neither reads an operand. `load.slot` is a slot; see the note above.
      return instruction
  }
}

export function substituteInTerminator(terminator: Terminator, subs: Substitution): Terminator {
  switch (terminator.op) {
    case 'branch':
      return { ...terminator, condition: resolve(terminator.condition, subs) }
    case 'return':
      return {
        ...terminator,
        value: terminator.value === null ? null : resolve(terminator.value, subs)
      }
    case 'jump':
    case 'unreachable':
      return terminator
  }
}

/**
 * Substitute through a whole block, optionally dropping instructions.
 *
 * `drop` runs BEFORE the rewrite, so an instruction on its way out is never
 * asked to substitute into itself. For `%1 = add 1, 2` that would be harmless;
 * for a phi that names its own result it would not be.
 */
export function substituteInBlock(
  block: Block,
  subs: Substitution,
  drop: (instruction: Instruction) => boolean = () => false
): Block {
  return {
    ...block,
    instructions: block.instructions
      .filter((instruction) => !drop(instruction))
      .map((instruction) => substituteInInstruction(instruction, subs)),
    terminator: substituteInTerminator(block.terminator, subs)
  }
}
