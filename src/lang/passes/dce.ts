import {
  predecessorsOf,
  reachableBlocks,
  successorsOf,
  terminatorUses,
  usesOf,
  type Block,
  type BlockId,
  type Instruction,
  type IrFunction,
  type Operand,
  type Phi,
  type Terminator,
  type ValueId
} from '../ir'
import type { Pass, PassResult } from '../pass-manager'

/**
 * Dead code elimination: removing what nothing can observe.
 *
 * The pass that teaches liveness. Constant folding rewrote instructions one at
 * a time and never had to look further than its own operands; this one cannot
 * decide anything about a single instruction without knowing what the whole
 * function does with it.
 *
 * Three kinds of dead, and they feed each other, which is why one round is not
 * enough:
 *
 *  1. A block with no path from the entry. Folding `if 1 < 2` leaves the else
 *     branch reachable in the graph but pointless; folding the BRANCH — which
 *     happens here, not in the folder — is what actually orphans it.
 *  2. An instruction whose result nothing reads.
 *  3. A phi argument on an edge that no longer exists, because the block it
 *     came from is gone.
 *
 * ## This pass owns the branch-to-jump rewrite
 *
 * `const-fold` deliberately leaves `branch true, then, else` alone: turning it
 * into `jump then` strands the else block, which the verifier reports as
 * `unreachable-block`, and the pipeline would refuse the pass. It is legal
 * HERE because this pass removes the orphan in the same breath. That is the
 * whole reason the two are separate passes rather than one — each is a thing a
 * reader can hold in their head, and the seam between them is a rule the
 * verifier enforces rather than a convention someone has to remember.
 *
 * ## What counts as observable
 *
 * `print` and `call` stay, always. A print is the program's only output, and a
 * call may print inside. BCC has no purity analysis and inventing one to delete
 * a call would be the kind of optimisation that is right until it deletes the
 * thing the user was testing with.
 *
 * `store` stays too, and that is a real limitation rather than an oversight: a
 * store to a slot that is never loaded again is genuinely dead, but proving
 * "never loaded again" needs the dominance walk mem2reg is about to do anyway.
 * Doing it twice, worse the first time, is not a saving. After mem2reg the
 * stores are gone entirely and the question stops being interesting.
 */

/** A hard bound. The rounds converge quickly; this is a hang guard, not a tuning knob. */
const MAX_ROUNDS = 32

/* -------------------------------------------------------------------------- */
/*  Simplifying terminators                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `branch true, a, b` → `jump a`. Null when there is nothing to do.
 *
 * A branch on a constant is the only terminator with a simpler form. Note the
 * `ifTrue === ifFalse` case is left alone deliberately: both edges go to the
 * same block, but a phi there has one argument PER EDGE, and collapsing the two
 * edges into one would leave every phi in the target with one argument too
 * many. `ir.ts` keeps duplicate predecessors for exactly this reason. Fixing
 * the phis at the same time is possible and is a second pass's worth of care
 * for a shape the front end does not currently emit.
 */
function simplify(terminator: Terminator): Terminator | null {
  if (terminator.op !== 'branch') return null
  if (terminator.condition.kind !== 'const') return null
  if (typeof terminator.condition.value !== 'boolean') return null
  if (terminator.ifTrue === terminator.ifFalse) return null

  return {
    op: 'jump',
    target: terminator.condition.value ? terminator.ifTrue : terminator.ifFalse,
    span: terminator.span
  }
}

/* -------------------------------------------------------------------------- */
/*  Liveness                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * An instruction that must stay whatever reads it.
 *
 * The list is short on purpose. Everything NOT on it is deletable when nothing
 * reads its result, and getting that backwards deletes a side effect — so the
 * conservative direction is to add to this list, never to trim it.
 */
function hasEffect(instruction: Instruction): boolean {
  return instruction.op === 'print' || instruction.op === 'call' || instruction.op === 'store'
}

/**
 * The values that are read, computed to a fixpoint.
 *
 * Iterative because uses chain backwards: `%3 = + %2, 1` keeps `%2` alive only
 * if something keeps `%3` alive. Walking instructions once in any order would
 * get part of the answer and call it done.
 */
function liveValues(blocks: readonly Block[]): Set<ValueId> {
  const live = new Set<ValueId>()

  // Seed: everything an effectful instruction or a terminator reads.
  for (const block of blocks) {
    for (const instruction of block.instructions) {
      if (hasEffect(instruction)) for (const id of usesOf(instruction)) live.add(id)
    }
    for (const id of terminatorUses(block.terminator)) live.add(id)
  }

  let growing = true
  while (growing) {
    growing = false
    for (const block of blocks) {
      for (const instruction of block.instructions) {
        const result = definitionIfAny(instruction)
        if (result === null || !live.has(result)) continue
        for (const id of usesOf(instruction)) {
          if (!live.has(id)) {
            live.add(id)
            growing = true
          }
        }
      }
    }
  }

  return live
}

/** `definitionOf`, but narrowed to the ops this pass may delete. */
function definitionIfAny(instruction: Instruction): ValueId | null {
  switch (instruction.op) {
    case 'alloca':
    case 'load':
    case 'binary':
    case 'unary':
    case 'phi':
      return instruction.result
    case 'call':
      return instruction.result
    case 'store':
    case 'print':
      return null
  }
}

/* -------------------------------------------------------------------------- */
/*  One round                                                                  */
/* -------------------------------------------------------------------------- */

interface Round {
  readonly fn: IrFunction
  readonly blocksRemoved: number
  readonly instructionsRemoved: number
  readonly branchesSimplified: number
}

function eliminateOnce(fn: IrFunction): Round | null {
  /* 1. Simplify constant branches, so the reachability walk below sees the
   *    graph the program actually has rather than the one it was written as. */
  let branchesSimplified = 0
  const simplified: Block[] = fn.blocks.map((block) => {
    const next = simplify(block.terminator)
    if (next === null) return block
    branchesSimplified++
    return { ...block, terminator: next }
  })

  /* 2. Drop blocks with no path from the entry. */
  const reachable = reachableBlocks({ ...fn, blocks: simplified })
  const kept = simplified.filter((block) => reachable.has(block.id))
  const blocksRemoved = simplified.length - kept.length

  /* 3. Drop phi arguments whose edge is gone.
   *
   *    A phi runs parallel to `predecessorsOf`, one argument per incoming EDGE.
   *    Removing a block removes its edges, so every phi in every block it
   *    reached now has too many arguments — which the verifier reports as
   *    `phi-arity-mismatch`. Rebuilding from the surviving predecessors is what
   *    keeps this pass's own output legal. */
  const predecessors = predecessorsOf({ ...fn, blocks: kept })
  const repaired: Block[] = kept.map((block) => ({
    ...block,
    instructions: block.instructions.map((instruction) =>
      instruction.op === 'phi' ? prunePhi(instruction, predecessors.get(block.id) ?? []) : instruction
    )
  }))

  /* 4. Drop instructions nothing reads. Done last, because steps 1-3 are what
   *    made some of them dead. */
  const live = liveValues(repaired)
  let instructionsRemoved = 0
  const cleaned: Block[] = repaired.map((block) => {
    const instructions = block.instructions.filter((instruction) => {
      if (hasEffect(instruction)) return true
      const result = definitionIfAny(instruction)
      if (result === null || live.has(result)) return true
      instructionsRemoved++
      return false
    })
    return { ...block, instructions }
  })

  if (blocksRemoved === 0 && instructionsRemoved === 0 && branchesSimplified === 0) return null

  return {
    fn: { ...fn, blocks: cleaned },
    blocksRemoved,
    instructionsRemoved,
    branchesSimplified
  }
}

/**
 * A phi with one argument per surviving edge.
 *
 * Matching is by predecessor block, and a predecessor appearing twice — a
 * `branch %c, join, join` — takes two arguments, so the count is what drives
 * this rather than a set. An argument for an edge that no longer exists is
 * dropped; an edge with no argument keeps the phi as it was, because inventing
 * a value here would be a guess, and the verifier reporting
 * `phi-arity-mismatch` is a far better outcome than a wrong number.
 */
function prunePhi(phi: Phi, predecessors: readonly BlockId[]): Phi {
  const remaining = [...phi.incoming]
  // A mutable local, widened back to the readonly field on return. Declaring it
  // as `Phi['incoming']` and pushing into it typechecks nowhere.
  const incoming: { readonly from: BlockId; readonly value: Operand }[] = []

  for (const predecessor of predecessors) {
    const index = remaining.findIndex((edge) => edge.from === predecessor)
    if (index === -1) return phi
    incoming.push(remaining[index] as { readonly from: BlockId; readonly value: Operand })
    remaining.splice(index, 1)
  }

  return { ...phi, incoming }
}

/* -------------------------------------------------------------------------- */
/*  The pass                                                                   */
/* -------------------------------------------------------------------------- */

export const deadCodeElimination: Pass = {
  name: 'dce',
  summary: 'removes blocks, instructions and phi arms that nothing can observe',

  run(fn: IrFunction): PassResult {
    let current = fn
    let blocks = 0
    let instructions = 0
    let branches = 0
    let rounds = 0

    for (; rounds < MAX_ROUNDS; rounds++) {
      const round = eliminateOnce(current)
      if (round === null) break
      current = round.fn
      blocks += round.blocksRemoved
      instructions += round.instructionsRemoved
      branches += round.branchesSimplified
    }

    if (rounds === 0) return { fn, notes: [] }

    const notes: string[] = []
    if (branches > 0) notes.push(`simplified ${branches} constant ${plural(branches, 'branch', 'branches')}`)
    if (blocks > 0) notes.push(`removed ${blocks} unreachable ${plural(blocks, 'block', 'blocks')}`)
    if (instructions > 0) {
      notes.push(`removed ${instructions} dead ${plural(instructions, 'instruction', 'instructions')}`)
    }

    return { fn: current, notes }
  }
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many
}

/** Exported for the tests, which assert the seam rather than the whole pass. */
export const forTesting = { simplify, liveValues, successorsOf }
