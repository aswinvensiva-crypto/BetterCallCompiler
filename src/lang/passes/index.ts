import type { Pass } from '../pass-manager'
import { constantFolding } from './const-fold'
import { copyPropagation } from './copy-prop'
import { deadCodeElimination } from './dce'
import { mem2reg } from './mem2reg'

export { constantFolding } from './const-fold'
export { copyPropagation } from './copy-prop'
export { deadCodeElimination } from './dce'
export { mem2reg } from './mem2reg'

/**
 * The order the four passes run in, and why it is this one.
 *
 * Each pass here produces the raw material the next one needs, which is what
 * makes the sequence worth writing down rather than leaving to a caller:
 *
 *  1. **mem2reg** first, because everything downstream is blocked on it. While
 *     `x` lives in an `alloca`, a `load` is opaque — a store between two reads
 *     could have changed it — so folding will not touch it and copy propagation
 *     has no phis to look at. Promoting is what turns memory traffic into
 *     values the other three can reason about.
 *  2. **const-fold** next, on the values mem2reg just exposed. This is where
 *     `let a = 1 + 2; let b = a + 3;` finally collapses: before promotion the
 *     chain went through memory and folding correctly refused it.
 *  3. **dce** third, and it has two jobs by now. It deletes the phis mem2reg
 *     placed by dominance frontier without asking whether anything reads them —
 *     "minimal" SSA leaves those on purpose, because deleting them here is free
 *     and computing liveness in `ssa.ts` would not be. And it simplifies the
 *     branches folding just made constant, removing the blocks that strands.
 *  4. **copy-prop** last, because its input is what step 3 produces. A phi loses
 *     an arm exactly when DCE deletes a predecessor, and a one-armed phi is no
 *     longer a choice.
 *
 * There is no second fold round. It would find a little more on some programs —
 * a phi collapsed by copy-prop can expose a foldable operand — and the pipeline
 * is deliberately a fixed list rather than a loop to a fixpoint, because a
 * teaching compiler whose pass order is "keep going until nothing changes" has
 * hidden the very thing the Observatory exists to show. Part 12 makes each pass
 * a memoised query; that is the right place to revisit this.
 */
export const OPTIMISATION_PIPELINE: readonly Pass[] = [
  mem2reg,
  constantFolding,
  deadCodeElimination,
  copyPropagation
]
