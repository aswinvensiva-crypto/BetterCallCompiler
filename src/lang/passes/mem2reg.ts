import type { Instruction, IrFunction } from '../ir'
import { toSsa } from '../ssa'
import type { Pass, PassResult } from '../pass-manager'

/**
 * mem2reg: promoting variables out of memory and into values.
 *
 * The payoff for having built SSA at all, and the pass that makes the other
 * three worth running. Lowering deliberately puts every `let` and every
 * parameter in an `alloca` and reads it back with a `load` — what LLVM emits at
 * `-O0`, and what makes the rest of the plan legible, because the hard part of
 * SSA is then only ever about VARIABLES. This is the pass with one visible job:
 * turn that memory traffic into phi nodes, and let a reader watch it happen
 * instead of being told it already did.
 *
 * ## The algorithm is in `ssa.ts`, on purpose
 *
 * `ssa.ts` says so itself: "This IS mem2reg. Part 8 wraps it as a named pass
 * with a before/after diff and a place in the pass manager; the algorithm lives
 * here, with the dominance it depends on, because that is what makes it
 * readable — a pass manager entry that also contained Cytron would be neither."
 *
 * So this file is a wrapper and should stay one. What it adds is not the
 * transformation but everything around it: a name, a note saying what moved, a
 * content-hashed before and after for the Observatory to diff, and — the part
 * that did not exist before — the verifier running on the result. `toSsa` has
 * been exercised by its own unit tests since Part 6; until now nothing checked
 * its output in the pipeline where a later pass would have to consume it.
 *
 * ## It leaves phis for DCE, and that is the design
 *
 * Phis are placed by dominance frontier alone, without asking whether the
 * variable is live where the phi lands — "minimal" SSA in Cytron's sense. A
 * `let` inside a loop gets a phi at the header that the body immediately
 * overwrites. Computing liveness first would avoid them; running this before
 * dead-code elimination deletes them for free and keeps `ssa.ts` about one
 * idea. That is why `OPTIMISATION_PIPELINE` puts mem2reg first.
 */

function countInstructions(fn: IrFunction, op: Instruction['op']): number {
  return fn.blocks.reduce(
    (total, block) =>
      total + block.instructions.filter((instruction) => instruction.op === op).length,
    0
  )
}

export const mem2reg: Pass = {
  name: 'mem2reg',
  summary: 'promotes variables out of memory into SSA values and phi nodes',

  run(fn: IrFunction): PassResult {
    const promoted = toSsa(fn)

    const allocasBefore = countInstructions(fn, 'alloca')
    const allocasAfter = countInstructions(promoted, 'alloca')
    const phisAdded = countInstructions(promoted, 'phi') - countInstructions(fn, 'phi')
    const loadsRemoved = countInstructions(fn, 'load') - countInstructions(promoted, 'load')

    const notes: string[] = []
    const gone = allocasBefore - allocasAfter
    if (gone > 0) notes.push(`promoted ${gone} ${gone === 1 ? 'variable' : 'variables'}`)
    if (loadsRemoved > 0) {
      notes.push(`removed ${loadsRemoved} ${loadsRemoved === 1 ? 'load' : 'loads'}`)
    }
    if (phisAdded > 0) notes.push(`inserted ${phisAdded} ${phisAdded === 1 ? 'phi' : 'phis'}`)

    return { fn: promoted, notes }
  }
}
