import type { Block, IrFunction, Operand, Phi, ValueId } from '../ir'
import type { Pass, PassResult } from '../pass-manager'
import { resolve, substituteInBlock, type Substitution } from './substitute'

/**
 * Copy propagation: deleting values that are only another value under a new name.
 *
 * The pass that teaches use-def walking. Folding read one instruction's
 * operands; DCE asked what the whole function reads. This one asks what a value
 * IS — chasing each definition back to the thing it actually names — and it is
 * the first pass here whose input is produced by another pass rather than by
 * lowering.
 *
 * ## The copies are phis, because this IR has no `mov`
 *
 * There is no copy instruction to propagate. `%3 = %2` cannot be written. What
 * CAN be written, and what the earlier passes produce in quantity, is a phi
 * that has stopped being a choice:
 *
 *   %3 = phi x [then.1, %2]              one arm — not a choice at all
 *   %3 = phi x [then.1, %2], [else.2, %2] both arms the same — still not one
 *
 * The first shape is exactly what DCE leaves behind when it deletes a
 * predecessor, which is why these two passes belong next to each other and in
 * this order. The second is what mem2reg will produce whenever a variable is
 * assigned the same value on every path.
 *
 * ## A phi may name itself, and that is not a cycle
 *
 * `%3 = phi i [entry, %1], [loop.body, %3]` is the ordinary shape of a
 * loop-carried variable that is never reassigned. Excluding self-references
 * before asking "are all the arms the same?" is what makes `%3` resolve to
 * `%1` rather than being left alone forever — the rule Braun's SSA construction
 * states, and the reason this pass can simplify a loop at all.
 *
 * A phi whose arms are ALL self-references names nothing. It can only occur in
 * a block the entry cannot reach, which the verifier already rejects, so it is
 * left exactly as found rather than resolved to a value invented here.
 */

/** A hard bound. Each round strictly removes a phi, so this is a hang guard. */
const MAX_ROUNDS = 32

/* -------------------------------------------------------------------------- */
/*  What a phi really names                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The single value a phi is equivalent to, or null when it is a real choice.
 *
 * Comparison is by printed operand rather than by object identity: two arms
 * carrying `constant(3)` are different objects and the same value, and a check
 * that missed that would leave every phi mem2reg builds over a constant.
 */
function trivialTarget(phi: Phi): Operand | null {
  const distinct = new Map<string, Operand>()

  for (const edge of phi.incoming) {
    // A self-reference says "whatever this phi already is", which constrains
    // nothing. Excluding it is what lets a loop-carried variable resolve.
    if (edge.value.kind === 'value' && edge.value.id === phi.result) continue
    distinct.set(keyOf(edge.value), edge.value)
  }

  if (distinct.size !== 1) return null
  return [...distinct.values()][0] ?? null
}

function keyOf(operand: Operand): string {
  return operand.kind === 'value' ? `%${operand.id}` : `#${String(operand.value)}`
}

/* -------------------------------------------------------------------------- */
/*  One round                                                                  */
/* -------------------------------------------------------------------------- */

function propagateOnce(fn: IrFunction): IrFunction | null {
  const copies = new Map<ValueId, Operand>()

  for (const block of fn.blocks) {
    for (const instruction of block.instructions) {
      if (instruction.op !== 'phi') continue
      const target = trivialTarget(instruction)
      if (target !== null) copies.set(instruction.result, target)
    }
  }

  if (copies.size === 0) return null

  /*
   * A chain of trivial phis resolves in one round rather than several, because
   * `resolve` follows the map to its end. Without that, `%3 → %2` and
   * `%2 → %1` would take a round each and the note would over-report the work.
   */
  const substitution: Substitution = copies

  const blocks: Block[] = fn.blocks.map((block) =>
    substituteInBlock(
      block,
      substitution,
      (instruction) => instruction.op === 'phi' && copies.has(instruction.result)
    )
  )

  return { ...fn, blocks }
}

/* -------------------------------------------------------------------------- */
/*  The pass                                                                   */
/* -------------------------------------------------------------------------- */

export const copyPropagation: Pass = {
  name: 'copy-prop',
  summary: 'removes phis that are not a choice, and rewrites what read them',

  run(fn: IrFunction): PassResult {
    let current = fn
    let rounds = 0
    let removed = 0

    for (; rounds < MAX_ROUNDS; rounds++) {
      const before = countPhis(current)
      const next = propagateOnce(current)
      if (next === null) break
      removed += before - countPhis(next)
      current = next
    }

    if (rounds === 0) return { fn, notes: [] }

    return {
      fn: current,
      notes: [`propagated ${removed} trivial ${removed === 1 ? 'phi' : 'phis'}`]
    }
  }
}

function countPhis(fn: IrFunction): number {
  return fn.blocks.reduce(
    (total, block) =>
      total + block.instructions.filter((instruction) => instruction.op === 'phi').length,
    0
  )
}

/** Exported for the tests, which assert the rule rather than only the pass. */
export const forTesting = { trivialTarget, resolve }
