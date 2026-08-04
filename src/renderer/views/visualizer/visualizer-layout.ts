import type {
  CodeGraph,
  CodeGraphEdge,
  CodeGraphNode,
  GraphNodeKind
} from '../../../shared/code-graph'

/**
 * Geometry for the Visualizer canvas: a `CodeGraph` in, boxes and beziers out.
 *
 * This is the one part of the new Visualizer that is worth testing properly, so
 * it is deliberately the one part that touches nothing else. No DOM, no
 * `document`, no measurement, no clock, no randomness — the same graph and the
 * same options always produce byte-identical output. That constraint is what
 * lets `visualizer-layout.test.ts` assert on coordinates instead of on
 * screenshots, and it is why label widths are *estimated* from character counts
 * rather than measured: a real measurement needs a laid-out `<text>` node, which
 * would drag a headless browser into the unit suite for a number that only has
 * to be approximately right.
 *
 * Layered ("Sugiyama-style"), flowing LEFT TO RIGHT: rank is a column, siblings
 * stack down it. Top-to-bottom is the more familiar flowchart orientation and
 * was the obvious first choice, but the Visualizer lives in a dock — a wide,
 * short strip — and a vertical tree in a dock is a column of boxes with acres of
 * dead space either side. Horizontal fills the space the panel actually has.
 *
 * The full Sugiyama pipeline is five phases; this is three of them (rank,
 * order, position) and skips the other two on purpose. There is no cycle
 * *removal* phase — cycles are stepped around during ranking instead of being
 * reversed and restored — and no dummy-node chain for long edges, so an edge
 * spanning four ranks flies over the intervening ones rather than being routed
 * around them. Both are real limitations. Both are cheaper than the alternative
 * on a function-sized graph, which is what this thing draws 99% of the time,
 * and this runs on a debounced cursor move where the budget is a few
 * milliseconds.
 *
 * `layoutGraph` NEVER THROWS and never emits `NaN`. Both matter more than they
 * sound: it is called on every keystroke-debounced cursor move, so an exception
 * takes the panel down mid-edit, and `NaN` in an SVG `d` attribute is not an
 * error — the browser silently draws nothing, which looks exactly like "that
 * edge does not exist". Every coordinate that leaves this file goes through
 * `round`, which is the single choke point where non-finite numbers die.
 */

/* ------------------------------- public API ------------------------------ */

export interface LayoutOptions {
  /** Expansion depth from the roots; nodes deeper than this are omitted. 1-10. */
  readonly maxDepth: number
  /** Max siblings rendered per rank before the rest collapse into one "+N more" node. 1-40. */
  readonly fanOut: number
}

export interface LaidOutNode {
  readonly node: CodeGraphNode
  /** Top-left corner, in graph space. */
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  /** Rank (column for horizontal flow). */
  readonly rank: number
  /** True for a synthesised "+N more" placeholder, which has no real source location. */
  readonly isOverflow: boolean
}

export interface LaidOutEdge {
  readonly edge: CodeGraphEdge
  /** An SVG path 'd' attribute — a cubic bezier in graph space. */
  readonly path: string
  /** Where to place the edge caption, if it has one. */
  readonly labelX: number
  readonly labelY: number
}

export interface GraphLayout {
  readonly nodes: readonly LaidOutNode[]
  readonly edges: readonly LaidOutEdge[]
  /** Bounding box of the whole drawing, in graph space. */
  readonly width: number
  readonly height: number
  /** Longest rank chain actually rendered — the toolbar reports it. */
  readonly depth: number
  /** How many nodes the depth/fan-out limits hid. The UI must be able to say so. */
  readonly hiddenCount: number
}

const EMPTY_LAYOUT: GraphLayout = {
  nodes: [],
  edges: [],
  width: 0,
  height: 0,
  depth: 0,
  hiddenCount: 0
}

/* ------------------------------ tuning knobs ----------------------------- */

/**
 * Graph space is CSS pixels at zoom 1. These are the only numbers in the new
 * Visualizer that are allowed to be hardcoded, and only because they are
 * *geometry*: an SVG `x` attribute cannot come from a CSS custom property, so
 * the choice is between naming them here and inventing a token system that only
 * this file reads. Colour, font and stroke are not here and must not be — they
 * live in `--bcc-*` and the pinned `viz-*` classes.
 */

/** Horizontal gap between rank columns. Wide enough for an edge caption to sit in. */
const RANK_GAP = 76
/** Vertical gap between two nodes in the same rank. */
const NODE_GAP = 18
/** Slack around the whole drawing so a bowed edge and a stroke width are not clipped. */
const MARGIN = 14

/**
 * Estimated average advance width of one label character.
 *
 * There is no DOM here and deliberately no offscreen measuring canvas either —
 * measuring would make layout impure and untestable for a number that only has
 * to be roughly right. 6.6px is a deliberate OVER-estimate for the ~12px UI font
 * this panel uses (lower-case Latin averages nearer 6.0). Over-estimating is the
 * safe direction: a label rattling around in a box 10px too wide reads as
 * slightly loose, whereas a label overflowing a box 10px too narrow reads as
 * broken. Labels arrive pre-clipped to 72 characters by the graph builder, so
 * the estimate never compounds far before `MAX_NODE_WIDTH` takes over anyway.
 */
const CHAR_WIDTH = 6.6
/** Left + right breathing room inside a node box. */
const LABEL_PADDING_X = 26
/** Extra width reserved when an async/generator badge sits beside the label. */
const BADGE_WIDTH = 22
const MIN_NODE_WIDTH = 84
const MAX_NODE_WIDTH = 248

/**
 * Height is per-kind rather than per-content because it is the one dimension the
 * eye uses to scan a column: rows of ragged heights read as noise, whereas
 * "declarations are the tall ones, terminals are the short ones" is information.
 */
const KIND_HEIGHT: Readonly<Record<GraphNodeKind, number>> = {
  entry: 40,
  function: 40,
  method: 40,
  class: 40,
  if: 34,
  switch: 34,
  case: 30,
  for: 34,
  while: 34,
  dowhile: 34,
  try: 34,
  catch: 34,
  finally: 34,
  return: 30,
  throw: 30,
  call: 30,
  leaf: 30,
  merge: 24
}
const FALLBACK_NODE_HEIGHT = 30
/** A node carrying metrics gets a second text row under the label. */
const METRIC_ROW_HEIGHT = 16

/** How far a forward edge's control points reach horizontally, as a fraction of the gap. */
const CURVE_REACH_RATIO = 0.55
const MIN_CURVE_REACH = 18
/** How far above the higher endpoint a loop-back arcs. */
const LOOP_BOW = 46
/** Below this horizontal span a bow would collapse into a spike, so its ends are pushed apart. */
const MIN_BOW_SPAN = 44
/** Self-edge lobe: how far right of the node it reaches, and how tall its mouth is. */
const SELF_LOOP_REACH = 40
const SELF_LOOP_MOUTH = 7

const OVERFLOW_ID_PREFIX = 'overflow_r'

const MIN_DEPTH_OPTION = 1
const MAX_DEPTH_OPTION = 10
const MIN_FAN_OUT_OPTION = 1
const MAX_FAN_OUT_OPTION = 40

/* -------------------------------- numerics ------------------------------- */

/**
 * The NaN firewall. Every number this file emits — coordinate, dimension, path
 * segment — passes through here.
 *
 * Coercing to 0 rather than throwing is the deliberate choice: a node drawn in
 * the wrong place is a visible bug someone reports, and an exception on a
 * debounced cursor move is a panel that disappears while the user is typing.
 * Two decimal places keeps the `d` strings short without any visible loss at the
 * zoom levels the canvas allows.
 */
function round(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(value * 100) / 100
}

/**
 * Options come off a toolbar slider, so `NaN`, `0` and `1e9` are all reachable
 * from a UI bug or a stale persisted setting. Out-of-range clamps to the range;
 * *unparseable* clamps to the maximum rather than the minimum, because the
 * failure mode of showing too much is a busy diagram, and the failure mode of
 * showing too little is a diagram that quietly lies about the code.
 */
function clampOption(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return max
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/* -------------------------------- sizing --------------------------------- */

function nodeWidth(node: CodeGraphNode): number {
  // Same defensive reasoning as `nodeHeight` below: the type says this is a
  // string, but an unvalidated graph off the IPC channel could disagree, and
  // reading `.length` off `undefined` is the one thing in this file that would
  // actually throw.
  const label = typeof node.label === 'string' ? node.label : ''
  const badge = node.isAsync || node.isGenerator ? BADGE_WIDTH : 0
  const estimate = label.length * CHAR_WIDTH + LABEL_PADDING_X + badge
  if (!Number.isFinite(estimate)) return MIN_NODE_WIDTH
  return Math.round(Math.min(MAX_NODE_WIDTH, Math.max(MIN_NODE_WIDTH, estimate)))
}

function nodeHeight(node: CodeGraphNode): number {
  // Annotated as possibly-undefined on purpose. The record covers every member
  // of `GraphNodeKind`, so the compiler is right that this cannot be undefined —
  // but a graph that reaches the renderer over IPC without surviving
  // `codeGraphSchema` could carry a kind this build has never heard of, and
  // `undefined + METRIC_ROW_HEIGHT` is NaN, which draws as nothing at all.
  const base: number | undefined = KIND_HEIGHT[node.kind]
  const height = base ?? FALLBACK_NODE_HEIGHT
  return node.metrics === null ? height : height + METRIC_ROW_HEIGHT
}

/* -------------------------------- ranking -------------------------------- */

/** A node with its column assigned, before any of the limits have been applied. */
interface RankedNode {
  readonly node: CodeGraphNode
  readonly rank: number
}

/** A node with its box, mid-placement. `x`/`y` are filled in by `place`. */
interface Placed {
  readonly node: CodeGraphNode
  readonly rank: number
  readonly isOverflow: boolean
  readonly width: number
  readonly height: number
  x: number
  y: number
}

interface FlowGraph {
  /** Deduplicated, in the order the graph declared them. */
  readonly nodes: readonly CodeGraphNode[]
  /** Successors along edges that may contribute to ranking. */
  readonly successors: ReadonlyMap<string, readonly string[]>
  /** Edges that survived the loop-back/self filter, for the back-edge pass. */
  readonly flowEdges: readonly CodeGraphEdge[]
}

/**
 * Strips the edges that must not participate in ranking.
 *
 * `loop-back` is the important one and it is not a nicety: a `while` header has
 * an edge pointing back at it from the end of its own body, so a longest-path
 * ranker that follows it walks the loop forever raising the rank by one each
 * time and never terminates. Excluding them here — once, at the boundary — is
 * why nothing downstream has to think about it. The graph builder makes the same
 * exclusion when it computes `rootIds`, for the same reason, so the two agree
 * about what "forward" means.
 *
 * Self-edges go too. A node cannot be one rank deeper than itself, and direct
 * recursion (`function f() { f() }`) is legal, common, and would otherwise be an
 * instant infinite loop. It is still *drawn* — see `routeEdge` — just not ranked.
 */
function toFlowGraph(graph: CodeGraph): FlowGraph {
  const nodes: CodeGraphNode[] = []
  const known = new Set<string>()
  for (const node of graph.nodes) {
    // A duplicate id would be placed twice and overwrite itself in every lookup
    // table below. Cheaper to drop it here than to reason about it everywhere.
    if (known.has(node.id)) continue
    known.add(node.id)
    nodes.push(node)
  }

  const successors = new Map<string, string[]>()
  const flowEdges: CodeGraphEdge[] = []
  for (const edge of graph.edges) {
    if (edge.kind === 'loop-back') continue
    if (edge.source === edge.target) continue
    if (!known.has(edge.source) || !known.has(edge.target)) continue
    flowEdges.push(edge)
    const existing = successors.get(edge.source)
    if (existing === undefined) successors.set(edge.source, [edge.target])
    else existing.push(edge.target)
  }

  return { nodes, successors, flowEdges }
}

/**
 * Reverse post-order over the whole node set — a topological order of the graph
 * with its back edges removed, which is exactly what longest-path ranking needs.
 *
 * The DFS carries an explicit stack rather than recursing. That is not
 * stylistic: the fallback graph the builder emits for unparseable source is one
 * node per line chained end to end, so a 5,000-line file is a 5,000-deep
 * recursion and a blown call stack on a keystroke.
 *
 * Roots are visited first so the drawing starts where the graph says it starts,
 * then every remaining node is used as a seed in declaration order. That second
 * sweep is what keeps disconnected fragments — completely normal in file mode,
 * where two unrelated functions share no edge — from being dropped. Losing nodes
 * silently is the worst thing a layout can do, because the diagram still looks
 * perfectly plausible.
 */
function topologicalOrder(flow: FlowGraph, rootIds: readonly string[]): readonly string[] {
  const known = new Set(flow.nodes.map((node) => node.id))
  const visited = new Set<string>()
  const post: string[] = []

  interface Frame {
    readonly id: string
    cursor: number
  }

  const seed = (start: string): void => {
    if (!known.has(start) || visited.has(start)) return
    visited.add(start)
    const stack: Frame[] = [{ id: start, cursor: 0 }]

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]
      if (frame === undefined) break

      const children = flow.successors.get(frame.id)
      const next = children === undefined ? undefined : children[frame.cursor]
      if (next === undefined) {
        post.push(frame.id)
        stack.pop()
        continue
      }

      frame.cursor++
      // The visited set is the termination guarantee. A 'calls' cycle
      // (`a` calls `b` calls `a`) is legal input and survives the loop-back
      // filter above, so without this the stack grows without bound.
      if (visited.has(next)) continue
      visited.add(next)
      stack.push({ id: next, cursor: 0 })
    }
  }

  for (const id of rootIds) seed(id)
  for (const node of flow.nodes) seed(node.id)

  return post.reverse()
}

interface Ranking {
  readonly ranked: readonly RankedNode[]
  /** Predecessors along rank-increasing edges only — the parents worth aligning to. */
  readonly predecessors: ReadonlyMap<string, readonly string[]>
}

/**
 * Longest-path ranking: a node sits one column right of its deepest predecessor.
 *
 * Relaxing in topological order visits every node after all of its forward
 * predecessors, so one pass is exact — no iteration to a fixed point, no
 * worst-case blowup. An edge that points backwards in that order is, by
 * definition, closing a cycle; it is skipped for ranking and later drawn as a
 * bow so the diagram still admits the cycle exists.
 *
 * Every node starts at rank 0, which is also how an unreachable fragment gets
 * placed: its own component simply starts its own chain at column 0 rather than
 * being appended after everything else. Stacking components side by side would
 * be more literal but it makes the drawing enormously wide for no information —
 * the components are unrelated, so nothing is implied by sharing a column.
 */
function assignRanks(flow: FlowGraph, rootIds: readonly string[]): Ranking {
  const order = topologicalOrder(flow, rootIds)
  const position = new Map<string, number>()
  for (let index = 0; index < order.length; index++) {
    const id = order[index]
    if (id !== undefined) position.set(id, index)
  }

  const rank = new Map<string, number>()
  for (const node of flow.nodes) rank.set(node.id, 0)

  const predecessors = new Map<string, string[]>()
  const forward: CodeGraphEdge[] = []
  for (const edge of flow.flowEdges) {
    const from = position.get(edge.source)
    const to = position.get(edge.target)
    if (from === undefined || to === undefined) continue
    // A back edge in the DFS forest. Following it is what would loop forever.
    if (to <= from) continue
    forward.push(edge)
  }
  // Relaxing edges grouped by their source's topological position is what makes
  // one pass exact: a node's rank is final before any edge leaving it is used.
  // Relax in the graph's own edge order instead and a node can be raised after
  // its children were already ranked off the old value, which under-ranks whole
  // subtrees — a subtle wrongness that still draws a perfectly tidy diagram.
  forward.sort((a, b) => (position.get(a.source) ?? 0) - (position.get(b.source) ?? 0))

  for (const edge of forward) {
    const sourceRank = rank.get(edge.source) ?? 0
    const targetRank = rank.get(edge.target) ?? 0
    if (sourceRank + 1 > targetRank) rank.set(edge.target, sourceRank + 1)

    const existing = predecessors.get(edge.target)
    if (existing === undefined) predecessors.set(edge.target, [edge.source])
    else if (!existing.includes(edge.source)) existing.push(edge.source)
  }

  const ranked = flow.nodes.map((node) => ({ node, rank: rank.get(node.id) ?? 0 }))
  return { ranked, predecessors }
}

/* ------------------------------- the limits ------------------------------ */

/**
 * A stand-in for the siblings a fan-out cut removed.
 *
 * The id prefix cannot collide with a real one: the builder's ids are
 * `n<counter>_L<line>` and always start with `n` followed by a digit. `location`
 * is all zeros, which is unambiguous rather than arbitrary — every real position
 * in this app is 1-based, so line 0 exists nowhere — but consumers should read
 * `isOverflow` and not try to interpret the zeros.
 *
 * It is deliberately left UNCONNECTED. Wiring it to a parent would mean picking
 * one of the several parents whose children were cut and asserting a
 * relationship the source does not have. The node is a counter, not a step.
 */
function overflowNode(rank: number, hidden: number): CodeGraphNode {
  return {
    id: `${OVERFLOW_ID_PREFIX}${rank}`,
    kind: 'leaf',
    label: `+${hidden} more`,
    category: 'internal',
    location: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 },
    parentId: null,
    signature: null,
    params: [],
    returnType: null,
    visibility: null,
    isAsync: false,
    isGenerator: false,
    jsDoc: null,
    metrics: null,
    callers: [],
    callees: []
  }
}

function toPlaced(node: CodeGraphNode, rank: number, isOverflow: boolean): Placed {
  return {
    node,
    rank,
    isOverflow,
    width: nodeWidth(node),
    height: nodeHeight(node),
    x: 0,
    y: 0
  }
}

/**
 * Applies `maxDepth` and `fanOut`, left to right.
 *
 * The sweep runs in rank order because both limits cascade forwards: a node
 * whose every visible parent was cut by fan-out has nothing left to hang off,
 * and drawing it floating in mid-column claims it is a component root when it is
 * really an orphan. Since a forward edge always increases rank by at least one,
 * every predecessor has already been decided by the time its children are
 * considered, so one pass is enough.
 *
 * A node with no forward predecessors at all is kept regardless — that is a
 * genuine root, or the head of a cycle whose only incoming edges are back edges.
 */
function selectVisible(
  ranking: Ranking,
  maxDepth: number,
  fanOut: number
): readonly (readonly Placed[])[] {
  const byRank: CodeGraphNode[][] = []
  let deepest = 0
  for (const entry of ranking.ranked) {
    deepest = Math.max(deepest, entry.rank)
    const bucket = byRank[entry.rank]
    if (bucket === undefined) byRank[entry.rank] = [entry.node]
    else bucket.push(entry.node)
  }

  const kept = new Set<string>()
  const columns: Placed[][] = []
  const lastRank = Math.min(deepest, maxDepth - 1)

  for (let rank = 0; rank <= lastRank; rank++) {
    const bucket = byRank[rank] ?? []
    const eligible: CodeGraphNode[] = []
    for (const node of bucket) {
      const parents = ranking.predecessors.get(node.id)
      if (parents === undefined || parents.length === 0) eligible.push(node)
      else if (parents.some((parent) => kept.has(parent))) eligible.push(node)
    }

    const shown = eligible.slice(0, fanOut)
    for (const node of shown) kept.add(node.id)

    const column = shown.map((node) => toPlaced(node, rank, false))
    const cut = eligible.length - shown.length
    if (cut > 0) column.push(toPlaced(overflowNode(rank, cut), rank, true))

    // A rank that emptied out entirely (every candidate orphaned upstream) still
    // gets a column so the rank index keeps matching the column index.
    columns.push(column)
  }

  // Trailing empty columns would inflate `depth` and pad the bounding box with
  // nothing. Ranks beyond the last populated one carry no information.
  while (columns.length > 0 && (columns[columns.length - 1]?.length ?? 0) === 0) columns.pop()

  return columns
}

/* ------------------------------- placement ------------------------------- */

/**
 * Barycentre: the mean vertical centre of a node's already-placed parents.
 *
 * A node with no placed parent returns `+Infinity` so a stable sort sinks it to
 * the bottom of its column in declaration order. That is a choice, not a
 * fallback — a node in column 3 with no visible parent is either a component
 * root or the overflow placeholder, and gathering those at the bottom keeps them
 * from being interleaved through a tree they have nothing to do with.
 */
function barycentre(
  placed: Placed,
  predecessors: ReadonlyMap<string, readonly string[]>,
  positioned: ReadonlyMap<string, Placed>
): number {
  const parents = predecessors.get(placed.node.id)
  if (parents === undefined) return Number.POSITIVE_INFINITY

  let total = 0
  let count = 0
  for (const parent of parents) {
    const found = positioned.get(parent)
    if (found === undefined) continue
    total += found.y + found.height / 2
    count++
  }
  return count === 0 ? Number.POSITIVE_INFINITY : total / count
}

/**
 * Assigns every box an `x`/`y`, with one barycentre ordering pass per column.
 *
 * Column widths and stack heights are known before any ordering happens, because
 * reordering a column changes neither — which is what lets each column be
 * vertically centred against the *final* total height while the barycentres are
 * still being computed. Doing it the other way round (order first, centre
 * afterwards) shifts every column by a different amount after the alignment
 * decisions were made, undoing some of them.
 *
 * One pass, not the iterate-until-stable loop a real crossing minimiser runs.
 * On graphs this size the second pass buys almost nothing and the diagram is
 * read, not audited — a handful of extra crossings costs less than a layout that
 * takes 40ms on every keystroke.
 */
function place(
  columns: readonly (readonly Placed[])[],
  predecessors: ReadonlyMap<string, readonly string[]>
): ReadonlyMap<string, Placed> {
  const columnWidths: number[] = []
  const stackHeights: number[] = []
  let totalHeight = 0

  for (const column of columns) {
    let width = 0
    let height = 0
    for (const placed of column) {
      width = Math.max(width, placed.width)
      height += placed.height
    }
    if (column.length > 1) height += NODE_GAP * (column.length - 1)
    columnWidths.push(width)
    stackHeights.push(height)
    totalHeight = Math.max(totalHeight, height)
  }

  const positioned = new Map<string, Placed>()
  let x = 0

  for (let rank = 0; rank < columns.length; rank++) {
    const column = columns[rank] ?? []
    const ordered =
      rank === 0
        ? [...column]
        : column
            .map((placed, index) => ({
              placed,
              index,
              key: barycentre(placed, predecessors, positioned)
            }))
            // Equality is compared before subtracting so that two no-parent
            // nodes (both `+Infinity`) fall back to declaration order instead of
            // `Infinity - Infinity`, which is NaN and makes the sort incoherent.
            .sort((a, b) => (a.key === b.key ? a.index - b.index : a.key - b.key))
            .map((entry) => entry.placed)

    let y = (totalHeight - (stackHeights[rank] ?? 0)) / 2
    for (const placed of ordered) {
      placed.x = x
      placed.y = y
      positioned.set(placed.node.id, placed)
      y += placed.height + NODE_GAP
    }

    x += (columnWidths[rank] ?? 0) + RANK_GAP
  }

  return positioned
}

/* ----------------------------- edge routing ------------------------------ */

/** A single cubic, held as raw numbers so the bounding box can be taken before rounding. */
interface Curve {
  readonly edge: CodeGraphEdge
  readonly x0: number
  readonly y0: number
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
  readonly x3: number
  readonly y3: number
}

/**
 * Three shapes, and the distinction between them is the difference between a
 * diagram that describes the code and one that misrepresents it.
 *
 * A forward edge leaves the source's right face and enters the target's left
 * face, with horizontal control points, so the curve leaves and arrives along
 * the reading direction.
 *
 * A loop-back — or any edge that does not actually move rightwards, which is
 * what a 'calls' cycle looks like once ranked — arcs ABOVE both endpoints
 * instead. Drawn as a plain bezier it would cut straight through every box
 * between the two, and a line that passes through a node is indistinguishable
 * from a line that connects to it. The bow is ugly on purpose: a cycle should
 * look like a cycle.
 *
 * A self-edge is direct recursion. It gets a small lobe off the right face.
 * Without a special case the "from" and "to" points are identical, the control
 * points collapse onto them, and the result is a zero-length path — present in
 * the DOM, invisible on screen, which is the worst of both.
 */
function routeEdge(edge: CodeGraphEdge, source: Placed, target: Placed): Curve {
  const sourceMidY = source.y + source.height / 2

  if (edge.source === edge.target) {
    const right = source.x + source.width
    return {
      edge,
      x0: right,
      y0: sourceMidY - SELF_LOOP_MOUTH,
      x1: right + SELF_LOOP_REACH,
      y1: sourceMidY - SELF_LOOP_REACH,
      x2: right + SELF_LOOP_REACH,
      y2: sourceMidY + SELF_LOOP_REACH,
      x3: right,
      y3: sourceMidY + SELF_LOOP_MOUTH
    }
  }

  const targetMidY = target.y + target.height / 2
  const sourceRight = source.x + source.width
  const gap = target.x - sourceRight

  if (edge.kind !== 'loop-back' && gap > 0) {
    const reach = Math.max(MIN_CURVE_REACH, gap * CURVE_REACH_RATIO)
    return {
      edge,
      x0: sourceRight,
      y0: sourceMidY,
      x1: sourceRight + reach,
      y1: sourceMidY,
      x2: target.x - reach,
      y2: targetMidY,
      x3: target.x,
      y3: targetMidY
    }
  }

  const sourceMidX = source.x + source.width / 2
  const targetMidX = target.x + target.width / 2
  const crest = Math.min(source.y, target.y) - LOOP_BOW
  // Two nodes in the same column share an x, and a bow between them would be a
  // vertical spike. Pushing the control points apart gives it a visible belly.
  const spread = Math.abs(sourceMidX - targetMidX) < MIN_BOW_SPAN ? MIN_BOW_SPAN / 2 : 0

  return {
    edge,
    x0: sourceMidX,
    y0: source.y,
    x1: sourceMidX + spread,
    y1: crest,
    x2: targetMidX - spread,
    y2: crest,
    x3: targetMidX,
    y3: target.y
  }
}

/** The point at t=0.5 on a cubic. Exact, and it keeps a caption off the node boxes. */
function midpoint(a: number, b: number, c: number, d: number): number {
  return (a + 3 * b + 3 * c + d) / 8
}

/* ------------------------------ entry point ------------------------------ */

/**
 * Lays out `graph`. Pure, total, and never throws — see the file header for why
 * those three properties are load-bearing rather than aspirational.
 */
export function layoutGraph(graph: CodeGraph, options: LayoutOptions): GraphLayout {
  const maxDepth = clampOption(options.maxDepth, MIN_DEPTH_OPTION, MAX_DEPTH_OPTION)
  const fanOut = clampOption(options.fanOut, MIN_FAN_OUT_OPTION, MAX_FAN_OUT_OPTION)

  const flow = toFlowGraph(graph)
  if (flow.nodes.length === 0) return EMPTY_LAYOUT

  const ranking = assignRanks(flow, graph.rootIds)
  const columns = selectVisible(ranking, maxDepth, fanOut)
  if (columns.length === 0) {
    // Every node was hidden. The canvas draws its `viz-empty` state, but the
    // count still has to be honest or the toolbar reports "0 hidden" over a
    // blank panel.
    return { ...EMPTY_LAYOUT, hiddenCount: flow.nodes.length }
  }

  const positioned = place(columns, ranking.predecessors)

  const curves: Curve[] = []
  for (const edge of graph.edges) {
    const source = positioned.get(edge.source)
    const target = positioned.get(edge.target)
    // An edge with a hidden endpoint is not drawn dangling. The node it pointed
    // at is already counted in `hiddenCount`; a stub arrow to nowhere would say
    // something the graph does not.
    if (source === undefined || target === undefined) continue
    curves.push(routeEdge(edge, source, target))
  }

  // The bounding box is taken over control points as well as endpoints, so it is
  // slightly generous — a bezier never reaches its control points. Slightly too
  // much room is invisible; too little clips a loop-back's crest.
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  const extend = (x: number, y: number): void => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }

  const boxes: Placed[] = []
  for (const column of columns) {
    for (const placed of column) {
      const found = positioned.get(placed.node.id)
      if (found === undefined) continue
      boxes.push(found)
      extend(found.x, found.y)
      extend(found.x + found.width, found.y + found.height)
    }
  }
  for (const curve of curves) {
    extend(curve.x0, curve.y0)
    extend(curve.x1, curve.y1)
    extend(curve.x2, curve.y2)
    extend(curve.x3, curve.y3)
  }

  // Bows arc above the first row, so the drawing's origin is usually negative.
  // Everything is translated into positive space in one step here rather than
  // being clamped during routing, which would flatten the crest instead of
  // moving it.
  const originX = Number.isFinite(minX) ? minX : 0
  const originY = Number.isFinite(minY) ? minY : 0
  const dx = MARGIN - originX
  const dy = MARGIN - originY

  const nodes: LaidOutNode[] = boxes.map((placed) => ({
    node: placed.node,
    x: round(placed.x + dx),
    y: round(placed.y + dy),
    width: round(placed.width),
    height: round(placed.height),
    rank: placed.rank,
    isOverflow: placed.isOverflow
  }))

  const edges: LaidOutEdge[] = curves.map((curve) => {
    const x0 = round(curve.x0 + dx)
    const y0 = round(curve.y0 + dy)
    const x1 = round(curve.x1 + dx)
    const y1 = round(curve.y1 + dy)
    const x2 = round(curve.x2 + dx)
    const y2 = round(curve.y2 + dy)
    const x3 = round(curve.x3 + dx)
    const y3 = round(curve.y3 + dy)
    return {
      edge: curve.edge,
      path: `M ${x0} ${y0} C ${x1} ${y1}, ${x2} ${y2}, ${x3} ${y3}`,
      labelX: round(midpoint(x0, x1, x2, x3)),
      labelY: round(midpoint(y0, y1, y2, y3))
    }
  })

  const spanX = Number.isFinite(maxX) ? maxX - originX : 0
  const spanY = Number.isFinite(maxY) ? maxY - originY : 0

  return {
    nodes,
    edges,
    width: round(spanX + MARGIN * 2),
    height: round(spanY + MARGIN * 2),
    depth: columns.length,
    // Derived by subtraction rather than accumulated during filtering. The two
    // limits interact — fan-out orphans descendants that the depth limit might
    // have cut anyway — and any counter threaded through that is one refactor
    // away from double-counting. This cannot disagree with what was drawn.
    hiddenCount: flow.nodes.length - nodes.filter((laid) => !laid.isOverflow).length
  }
}
