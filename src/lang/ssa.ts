import { computeDominance, type Dominance } from './dominance'
import {
  constant,
  definitionOf,
  predecessorsOf,
  successorsOf,
  terminatorUses,
  usesOf,
  value,
  type Block,
  type BlockId,
  type Instruction,
  type IrFunction,
  type Operand,
  type Phi,
  type Terminator,
  type ValueId
} from './ir'
import type { Type } from './type-check'

/**
 * Static single assignment: every value assigned exactly once, everywhere.
 *
 * Part 5 already gave that to values PRODUCED by instructions — each one names
 * a fresh result. What it did not give is variables: a `let` is an `alloca` and
 * every assignment is a `store`, so `x` is a location that changes rather than
 * a value that does not. This is where that gap closes.
 *
 * Two steps, and they are the classic ones (Cytron et al., TOPLAS 1991):
 *
 *   1. **Phi insertion.** Wherever a variable is stored in a block, a phi may
 *      be needed at every block in that block's dominance frontier — the places
 *      where this definition can meet a different one. Inserting a phi is
 *      itself a definition, so the process repeats to a fixed point.
 *   2. **Renaming.** Walk the dominator tree keeping a stack of the current
 *      value of each variable. A `load` becomes whatever is on top; a `store`
 *      pushes; a phi's arguments are filled in from each predecessor as that
 *      predecessor is finished.
 *
 * ## What this is, and what Part 8 calls it
 *
 * This IS mem2reg. Part 8 wraps it as a named pass with a before/after diff and
 * a place in the pass manager; the algorithm lives here, with the dominance it
 * depends on, because that is what makes it readable — a pass manager entry
 * that also contained Cytron would be neither.
 *
 * ## Minimal, not pruned
 *
 * Phis are placed by dominance frontier alone, without asking whether the
 * variable is actually live where the phi lands. That is "minimal" SSA in the
 * paper's sense, and it can leave phis nothing reads — a `let` inside a loop
 * gets one at the loop header that the body immediately overwrites. Computing
 * liveness first would avoid them; letting Part 8's dead-code elimination
 * delete them costs one pass and keeps this file about one idea.
 */

/** A variable being promoted: the alloca that was its home. */
interface Promotable {
  readonly slot: ValueId
  readonly name: string
  readonly type: Type
  /** Blocks containing a store to it. Where phi insertion starts. */
  readonly stores: Set<BlockId>
}

/**
 * Which allocas can become values.
 *
 * In BCC the answer is always "all of them" — there is no address-of, no array
 * and no pointer, so a slot can only ever be loaded from or stored to. It is
 * checked rather than assumed anyway: an alloca whose value is used as anything
 * other than the `slot` of a load or store has escaped, and promoting it would
 * silently drop whatever else was reading it.
 */
function promotableAllocas(fn: IrFunction): Map<ValueId, Promotable> {
  const candidates = new Map<ValueId, Promotable>()

  for (const block of fn.blocks) {
    for (const instruction of block.instructions) {
      if (instruction.op !== 'alloca') continue
      candidates.set(instruction.result, {
        slot: instruction.result,
        name: instruction.name,
        type: instruction.type,
        stores: new Set()
      })
    }
  }

  for (const block of fn.blocks) {
    for (const instruction of block.instructions) {
      switch (instruction.op) {
        case 'load':
          // Reading through the slot is the point; not an escape.
          break
        case 'store':
          candidates.get(instruction.slot)?.stores.add(block.id)
          // The stored VALUE escaping is what disqualifies: `store %a, %b`
          // where %b is itself an alloca means the slot's address was kept.
          if (instruction.value.kind === 'value') candidates.delete(instruction.value.id)
          break
        default:
          for (const used of usesOf(instruction)) candidates.delete(used)
      }
    }
    for (const used of terminatorUses(block.terminator)) candidates.delete(used)
  }

  return candidates
}

/* -------------------------------------------------------------------------- */
/*  Phi insertion                                                              */
/* -------------------------------------------------------------------------- */

interface PlannedPhi {
  readonly slot: ValueId
  readonly name: string
  readonly result: ValueId
}

/**
 * Where every phi goes, before anything is renamed.
 *
 * The worklist is over BLOCKS that define the variable, and a phi counts as a
 * definition — which is why a block gains a place on the list when it receives
 * one. Without that, a variable stored in a loop body would get a phi at the
 * header and none at a join further out that the header's value can also reach.
 */
function planPhis(
  dominance: Dominance,
  variables: Map<ValueId, Promotable>,
  nextValue: () => ValueId
): Map<BlockId, PlannedPhi[]> {
  const plan = new Map<BlockId, PlannedPhi[]>()

  for (const variable of variables.values()) {
    const placed = new Set<BlockId>()
    const worklist = [...variable.stores].filter((id) => dominance.reachable.has(id))

    while (worklist.length > 0) {
      const block = worklist.pop()
      if (block === undefined) continue

      for (const frontier of dominance.frontier.get(block) ?? []) {
        if (placed.has(frontier)) continue
        placed.add(frontier)

        const existing = plan.get(frontier) ?? []
        existing.push({ slot: variable.slot, name: variable.name, result: nextValue() })
        plan.set(frontier, existing)

        // The phi is itself a definition, so its block joins the worklist.
        if (!variable.stores.has(frontier)) worklist.push(frontier)
      }
    }
  }

  return plan
}

/* -------------------------------------------------------------------------- */
/*  Renaming                                                                   */
/* -------------------------------------------------------------------------- */

/** What an uninitialised variable reads as. Never observable in a valid program. */
function undefinedValue(type: Type): Operand {
  // Typed rather than a bare zero, so the IR stays well-typed even on the path
  // the type checker already proved cannot happen.
  return constant(type.kind === 'bool' ? false : 0)
}

export function toSsa(fn: IrFunction): IrFunction {
  const dominance = computeDominance(fn)
  const variables = promotableAllocas(fn)
  if (variables.size === 0) return fn

  let nextId = highestValue(fn) + 1
  const nextValue = (): ValueId => nextId++

  const plan = planPhis(dominance, variables, nextValue)
  const predecessors = predecessorsOf(fn)
  const byId = new Map(fn.blocks.map((block) => [block.id, block]))

  /** A load's result, and the value it turned out to be. */
  const replacement = new Map<ValueId, Operand>()
  /** The current value of each variable, innermost last. */
  const stacks = new Map<ValueId, Operand[]>()
  for (const slot of variables.keys()) stacks.set(slot, [])

  /** Filled in as each predecessor finishes. Keyed block -> phi index -> edge. */
  const phiArguments = new Map<BlockId, Map<number, Map<number, Operand>>>()

  const resolve = (operand: Operand): Operand =>
    operand.kind === 'value' ? (replacement.get(operand.id) ?? operand) : operand

  const currentOf = (slot: ValueId): Operand => {
    const stack = stacks.get(slot)
    const top = stack?.[stack.length - 1]
    if (top !== undefined) return top
    return undefinedValue(variables.get(slot)?.type ?? { kind: 'int' })
  }

  const rewritten = new Map<BlockId, Instruction[]>()

  /**
   * One block, in dominator-tree preorder.
   *
   * Preorder is what makes the stack discipline work: everything a block can
   * see is on the stack when it starts, because its dominator put it there, and
   * nothing a sibling pushed is still there, because the sibling popped.
   */
  const renameBlock = (id: BlockId): void => {
    const block = byId.get(id)
    if (block === undefined) return

    /** What this block pushed, so it can pop exactly that much on the way out. */
    const pushedSlots: ValueId[] = []
    const push = (slot: ValueId, operand: Operand): void => {
      stacks.get(slot)?.push(operand)
      pushedSlots.push(slot)
    }

    for (const phi of plan.get(id) ?? []) push(phi.slot, value(phi.result))

    const kept: Instruction[] = []

    for (const instruction of block.instructions) {
      switch (instruction.op) {
        case 'alloca':
          // Promoted: the slot no longer exists. A non-promotable one stays.
          if (variables.has(instruction.result)) continue
          kept.push(instruction)
          continue

        case 'load':
          if (variables.has(instruction.slot)) {
            // The load IS the current value. Recorded rather than emitted, and
            // every later use of its result is rewritten through this map.
            replacement.set(instruction.result, currentOf(instruction.slot))
            continue
          }
          kept.push(instruction)
          continue

        case 'store':
          if (variables.has(instruction.slot)) {
            // Resolved at PUSH time. Because the walk is in dominator order,
            // anything this value depends on has already been renamed, so the
            // operand on the stack is final and no later pass has to chase it.
            push(instruction.slot, resolve(instruction.value))
            continue
          }
          kept.push(rewriteOperands(instruction, resolve))
          continue

        default:
          kept.push(rewriteOperands(instruction, resolve))
      }
    }

    rewritten.set(id, kept)

    // Every successor's phi learns what this block leaves behind. Done per
    // EDGE, so a `branch %c, join, join` fills both of the join's arguments.
    for (const successor of successorsOf(block.terminator)) {
      const successorPhis = plan.get(successor) ?? []
      if (successorPhis.length === 0) continue

      const edges = predecessors.get(successor) ?? []
      const forBlock = phiArguments.get(successor) ?? new Map<number, Map<number, Operand>>()

      successorPhis.forEach((phi, phiIndex) => {
        const byEdge = forBlock.get(phiIndex) ?? new Map<number, Operand>()
        edges.forEach((from, edgeIndex) => {
          if (from !== id) return
          byEdge.set(edgeIndex, currentOf(phi.slot))
        })
        forBlock.set(phiIndex, byEdge)
      })

      phiArguments.set(successor, forBlock)
    }

    for (const child of dominance.children.get(id) ?? []) renameBlock(child)

    for (const slot of pushedSlots.reverse()) stacks.get(slot)?.pop()
  }

  // The recursion is bounded by the depth of the dominator tree, which for a
  // structured language is the source's own nesting depth — and therefore by
  // the parser's limit.
  renameBlock(fn.entry)

  /* --------------------------- rebuild the blocks ------------------------ */

  const blocks: Block[] = fn.blocks.map((block) => {
    const phis: Phi[] = (plan.get(block.id) ?? []).map((planned, phiIndex) => {
      const edges = predecessors.get(block.id) ?? []
      const filled = phiArguments.get(block.id)?.get(phiIndex)
      return {
        op: 'phi',
        result: planned.result,
        name: planned.name,
        incoming: edges.map((from, edgeIndex) => ({
          from,
          value: filled?.get(edgeIndex) ?? undefinedValue(variables.get(planned.slot)?.type ?? { kind: 'int' })
        })),
        span: block.instructions[0]?.span ?? fn.span
      }
    })

    return {
      id: block.id,
      label: block.label,
      // Phis first, always. They take effect on entry, simultaneously.
      instructions: [...phis, ...(rewritten.get(block.id) ?? block.instructions)],
      terminator: rewriteTerminator(block.terminator, resolve)
    }
  })

  return { ...fn, blocks }
}

function highestValue(fn: IrFunction): ValueId {
  let highest = -1
  for (const param of fn.params) highest = Math.max(highest, param.value)
  for (const block of fn.blocks) {
    for (const instruction of block.instructions) {
      const defined = definitionOf(instruction)
      if (defined !== null) highest = Math.max(highest, defined)
    }
  }
  return highest
}

function rewriteOperands(
  instruction: Instruction,
  resolve: (operand: Operand) => Operand
): Instruction {
  switch (instruction.op) {
    case 'store':
      return { ...instruction, value: resolve(instruction.value) }
    case 'binary':
      return { ...instruction, left: resolve(instruction.left), right: resolve(instruction.right) }
    case 'unary':
      return { ...instruction, operand: resolve(instruction.operand) }
    case 'call':
      return { ...instruction, args: instruction.args.map(resolve) }
    case 'print':
      return { ...instruction, value: resolve(instruction.value) }
    case 'phi':
      return {
        ...instruction,
        incoming: instruction.incoming.map((edge) => ({ ...edge, value: resolve(edge.value) }))
      }
    case 'alloca':
    case 'load':
      return instruction
  }
}

function rewriteTerminator(
  terminator: Terminator,
  resolve: (operand: Operand) => Operand
): Terminator {
  switch (terminator.op) {
    case 'branch':
      return { ...terminator, condition: resolve(terminator.condition) }
    case 'return':
      return terminator.value === null
        ? terminator
        : { ...terminator, value: resolve(terminator.value) }
    case 'jump':
    case 'unreachable':
      return terminator
  }
}
