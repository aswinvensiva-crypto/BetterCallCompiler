import { predecessorsOf, successorsOf, type BlockId, type IrFunction } from './ir'

/**
 * Dominators and dominance frontiers.
 *
 * Block `a` dominates block `b` when every path from the entry to `b` goes
 * through `a`. That one relation answers the two questions SSA needs: where a
 * phi has to go (the dominance frontier), and whether a use can legally see a
 * definition (does the def's block dominate the use's).
 *
 * ## The iterative algorithm, not Lengauer-Tarjan
 *
 * Cooper, Harvey and Kennedy's *A Simple, Fast Dominance Algorithm* (2001).
 * Lengauer-Tarjan is asymptotically better and is what production compilers
 * use; this one is a fixed-point loop over reverse postorder that fits on a
 * page, and at the size of a BCC function it is faster in practice as well as
 * being readable. The paper's own measurements say the same.
 *
 * It is also correct on IRREDUCIBLE graphs — ones where a loop has two entries
 * — which matters less for BCC (whose only loop is `while`, so nothing it
 * lowers can be irreducible) than for the fact that the algorithm is not
 * quietly assuming a property nobody checks. The tests build an irreducible CFG
 * by hand to prove it.
 *
 * ## Unreachable blocks
 *
 * Only reachable blocks get an entry. An unreachable block has no dominator
 * because there is no path to it to dominate, and inventing one would make
 * `dominates` answer questions about paths that do not exist. Lowering never
 * produces one, but a Part 8 pass that deletes a branch can, transiently.
 */

export interface Dominance {
  /**
   * The immediate dominator of each reachable block — its parent in the
   * dominator tree. The entry block maps to itself, which is the convention the
   * algorithm below needs and the one the paper uses.
   */
  readonly idom: ReadonlyMap<BlockId, BlockId>
  /** Children in the dominator tree, in reverse-postorder. */
  readonly children: ReadonlyMap<BlockId, readonly BlockId[]>
  /**
   * The dominance frontier: blocks where this block's dominance "runs out".
   *
   * `d` is in the frontier of `b` when `b` dominates a predecessor of `d` but
   * does not strictly dominate `d` itself. That is precisely the set of places
   * a value defined in `b` might meet a different value coming another way —
   * which is what a phi is for.
   */
  readonly frontier: ReadonlyMap<BlockId, ReadonlySet<BlockId>>
  /** Reverse postorder from the entry. The order the fixed point converges in. */
  readonly order: readonly BlockId[]
  /** Reachable from the entry. Everything else has no dominance information. */
  readonly reachable: ReadonlySet<BlockId>
  /** True when `a` dominates `b`. A block dominates itself. */
  dominates(a: BlockId, b: BlockId): boolean
  /** True when `a` dominates `b` and is not `b`. */
  strictlyDominates(a: BlockId, b: BlockId): boolean
}

/**
 * Postorder, reversed.
 *
 * The order matters: processing a block after its predecessors means the fixed
 * point converges in one or two passes instead of walking the whole graph
 * repeatedly. Written with an explicit stack rather than recursion, because a
 * long function is a deep graph and the parser's nesting limit says nothing
 * about how many BLOCKS a program has.
 */
function reversePostorder(fn: IrFunction): BlockId[] {
  const byId = new Map(fn.blocks.map((block) => [block.id, block]))
  const postorder: BlockId[] = []
  const visited = new Set<BlockId>()

  // Each frame remembers which successor comes next, so a block is appended
  // only once every path out of it has been explored.
  const stack: { id: BlockId; next: number }[] = [{ id: fn.entry, next: 0 }]
  visited.add(fn.entry)

  while (stack.length > 0) {
    const frame = stack[stack.length - 1]
    if (frame === undefined) break

    const block = byId.get(frame.id)
    const successors = block === undefined ? [] : successorsOf(block.terminator)

    if (frame.next >= successors.length) {
      postorder.push(frame.id)
      stack.pop()
      continue
    }

    const successor = successors[frame.next]
    frame.next++
    if (successor === undefined || visited.has(successor)) continue
    visited.add(successor)
    stack.push({ id: successor, next: 0 })
  }

  return postorder.reverse()
}

export function computeDominance(fn: IrFunction): Dominance {
  const order = reversePostorder(fn)
  const reachable = new Set(order)

  /** Position in reverse postorder — how `intersect` knows which way is up. */
  const rank = new Map<BlockId, number>()
  order.forEach((id, index) => rank.set(id, index))

  const predecessors = predecessorsOf(fn)
  const idom = new Map<BlockId, BlockId>()
  idom.set(fn.entry, fn.entry)

  /**
   * The nearest block that dominates both.
   *
   * Two fingers walking up the dominator tree, each step taken by whichever is
   * further from the entry. Reverse-postorder numbers give "further from the
   * entry" for free: a bigger number is deeper.
   */
  const intersect = (a: BlockId, b: BlockId): BlockId => {
    let left = a
    let right = b

    // Bounded like the walks above: two fingers climbing a chain cannot take
    // more steps than the graph has blocks.
    for (let step = 0; left !== right && step <= order.length; step++) {
      while ((rank.get(left) ?? 0) > (rank.get(right) ?? 0)) {
        const next = idom.get(left)
        if (next === undefined || next === left) break
        left = next
      }
      while ((rank.get(right) ?? 0) > (rank.get(left) ?? 0)) {
        const next = idom.get(right)
        if (next === undefined || next === right) break
        right = next
      }
      // Neither could move: a malformed graph rather than a slow convergence.
      // Returning the entry keeps the result a tree instead of looping forever.
      if (left !== right && (rank.get(left) ?? 0) === (rank.get(right) ?? 0)) return fn.entry
    }

    return left === right ? left : fn.entry
  }

  /*
   * The fixed point is bounded, not merely expected to converge.
   *
   * On a well-formed graph in reverse postorder this settles in one or two
   * rounds. On a MALFORMED one it need not settle at all: `idom.get(id) !==
   * candidate` is permanently true when both are NaN, so the loop would run
   * forever. A hang is worse than a wrong answer, because nothing reports it —
   * and this function is called by a verifier whose whole job is to survive
   * broken input.
   *
   * A dominator computation cannot need more rounds than there are blocks.
   */
  let changed = true
  let rounds = 0
  while (changed && rounds <= order.length) {
    changed = false
    rounds++

    for (const id of order) {
      if (id === fn.entry) continue

      // Only predecessors whose idom is already known contribute. On the first
      // pass over a loop header that is just the way in, and the back edge
      // joins on the next iteration — which is why this is a fixed point and
      // not a single sweep.
      let candidate: BlockId | null = null
      for (const predecessor of predecessors.get(id) ?? []) {
        if (!reachable.has(predecessor)) continue
        if (idom.get(predecessor) === undefined) continue
        candidate = candidate === null ? predecessor : intersect(predecessor, candidate)
      }

      if (candidate === null) continue
      if (idom.get(id) !== candidate) {
        idom.set(id, candidate)
        changed = true
      }
    }
  }

  /* ------------------------------ the tree ------------------------------- */

  const children = new Map<BlockId, BlockId[]>()
  for (const id of order) children.set(id, [])
  for (const id of order) {
    if (id === fn.entry) continue
    const parent = idom.get(id)
    if (parent === undefined || parent === id) continue
    children.get(parent)?.push(id)
  }

  /* --------------------------- the frontier ------------------------------ */

  /*
   * Cooper, Harvey and Kennedy again: for every block with more than one way
   * in, walk up from each predecessor until you reach the block's immediate
   * dominator, adding the block to the frontier of everything on the way.
   *
   * Only join points can be in anyone's frontier — a block with one
   * predecessor cannot be where two definitions meet — which is why the outer
   * loop skips everything else.
   */
  const frontier = new Map<BlockId, Set<BlockId>>()
  for (const id of order) frontier.set(id, new Set())

  for (const id of order) {
    const incoming = (predecessors.get(id) ?? []).filter((p) => reachable.has(p))
    if (incoming.length < 2) continue

    const stop = idom.get(id)
    for (const predecessor of incoming) {
      let runner = predecessor
      while (runner !== stop) {
        frontier.get(runner)?.add(id)
        const next = idom.get(runner)
        if (next === undefined || next === runner) break
        runner = next
      }
    }
  }

  /* ------------------------------ queries -------------------------------- */

  const dominates = (a: BlockId, b: BlockId): boolean => {
    if (!reachable.has(a) || !reachable.has(b)) return false

    // Walking the idom chain rather than keeping DFS in/out numbers. O(depth)
    // instead of O(1), and at BCC's scale the constant factor of maintaining
    // the numbers across Part 8's rewrites costs more than it saves.
    //
    // Bounded by the number of blocks for the same reason the fixed point is: a
    // chain cannot be longer than the graph, and `parent === current` fails to
    // detect a self-loop when the id is NaN — which spins here forever rather
    // than returning something wrong.
    let current = b
    for (let step = 0; step <= order.length; step++) {
      if (current === a) return true
      const parent = idom.get(current)
      if (parent === undefined || parent === current) return false
      current = parent
    }
    return false
  }

  return {
    idom,
    children,
    frontier,
    order,
    reachable,
    dominates,
    strictlyDominates: (a, b) => a !== b && dominates(a, b)
  }
}

/** The dominator tree from the entry down, parents before children. */
export function dominatorPreorder(dominance: Dominance, entry: BlockId): BlockId[] {
  const result: BlockId[] = []
  const stack: BlockId[] = [entry]

  while (stack.length > 0) {
    const id = stack.pop()
    if (id === undefined) continue
    result.push(id)
    // Reversed, so popping yields them in the order the children list holds.
    const children = [...(dominance.children.get(id) ?? [])].reverse()
    for (const child of children) stack.push(child)
  }

  return result
}
