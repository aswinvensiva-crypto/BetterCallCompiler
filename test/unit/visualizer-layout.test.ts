import { describe, expect, it } from 'vitest'
import { buildFileGraph, buildSelectionGraph } from '../../src/renderer/editor/code-graph'
import {
  layoutGraph,
  type GraphLayout,
  type LayoutOptions
} from '../../src/renderer/views/visualizer/visualizer-layout'
import type {
  CodeGraph,
  CodeGraphEdge,
  CodeGraphNode,
  GraphEdgeKind,
  GraphNodeKind
} from '../../src/shared/code-graph'

/**
 * The Visualizer's layout engine.
 *
 * Two things are being defended here, and they fail in opposite ways.
 *
 * The first is termination. A control-flow graph has cycles by construction — a
 * loop closes one — and a longest-path ranker that follows a cycle never stops.
 * That failure is loud: the panel hangs and takes the renderer with it.
 *
 * The second is silence. A dropped node, a `NaN` coordinate, or a truncation
 * that nothing reports all render as a perfectly plausible diagram that happens
 * to be wrong about the code. `NaN` in a path `d` is not even an error to the
 * browser; it just draws nothing. So the assertions below lean heavily on
 * invariants — every input node accounted for, every number finite, every box
 * inside the reported bounds — rather than on exact coordinates, which are
 * tuning constants and will move.
 */

/** Deliberately generous: nothing should be hidden unless a test asks for it. */
const OPEN: LayoutOptions = { maxDepth: 10, fanOut: 40 }

function node(id: string, overrides: Partial<CodeGraphNode> = {}): CodeGraphNode {
  return {
    id,
    kind: 'call' satisfies GraphNodeKind,
    label: id,
    category: 'internal',
    location: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
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
    callees: [],
    ...overrides
  }
}

function edge(source: string, target: string, kind: GraphEdgeKind = 'sequential'): CodeGraphEdge {
  return { id: `${source}->${target}`, source, target, kind, label: null }
}

/** Roots are derived the same way the builder derives them, so fixtures cannot drift. */
function graphOf(nodes: readonly CodeGraphNode[], edges: readonly CodeGraphEdge[]): CodeGraph {
  const reached = new Set(edges.filter((e) => e.kind !== 'loop-back').map((e) => e.target))
  return {
    mode: 'selection',
    nodes,
    edges,
    source: 'ast',
    error: null,
    rootIds: nodes.filter((n) => !reached.has(n.id)).map((n) => n.id)
  }
}

function idsOf(layout: GraphLayout): readonly string[] {
  return layout.nodes.map((laid) => laid.node.id)
}

function rankOf(layout: GraphLayout, id: string): number {
  const found = layout.nodes.find((laid) => laid.node.id === id)
  if (found === undefined) throw new Error(`node "${id}" was not laid out`)
  return found.rank
}

/** Pulls every number back out of an SVG path so a `d` can be checked numerically. */
function coordinatesIn(path: string): readonly number[] {
  return (path.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
}

/**
 * The invariant that has to hold for every layout this file produces, asserted
 * from a dozen different tests rather than one, because the interesting failures
 * only appear on specific graph shapes.
 */
function expectSane(layout: GraphLayout, graph: CodeGraph): void {
  for (const laid of layout.nodes) {
    for (const value of [laid.x, laid.y, laid.width, laid.height, laid.rank]) {
      expect(Number.isFinite(value)).toBe(true)
    }
    expect(laid.width).toBeGreaterThan(0)
    expect(laid.height).toBeGreaterThan(0)

    // The bounding box has to actually bound. A node outside it is a node the
    // canvas's viewBox will crop away without saying so.
    expect(laid.x).toBeGreaterThanOrEqual(0)
    expect(laid.y).toBeGreaterThanOrEqual(0)
    expect(laid.x + laid.width).toBeLessThanOrEqual(layout.width)
    expect(laid.y + laid.height).toBeLessThanOrEqual(layout.height)
  }

  for (const laid of layout.edges) {
    expect(laid.path).not.toMatch(/NaN|Infinity|undefined|null/)
    expect(laid.path).toMatch(/^M [\d.-]+ [\d.-]+ C /)
    for (const value of coordinatesIn(laid.path)) expect(Number.isFinite(value)).toBe(true)
    expect(Number.isFinite(laid.labelX)).toBe(true)
    expect(Number.isFinite(laid.labelY)).toBe(true)
  }

  for (const value of [layout.width, layout.height, layout.depth, layout.hiddenCount]) {
    expect(Number.isFinite(value)).toBe(true)
    expect(value).toBeGreaterThanOrEqual(0)
  }

  // Nothing may vanish unaccounted for: every input node is either drawn or
  // counted as hidden. Overflow placeholders are not input nodes and so are
  // excluded from the tally.
  const drawn = layout.nodes.filter((laid) => !laid.isOverflow).length
  expect(drawn + layout.hiddenCount).toBe(graph.nodes.length)
}

describe('ranking', () => {
  /**
   * The single most important correctness detail in the layout engine. A `while`
   * header has an edge from the end of its own body pointing back at it, so a
   * longest-path ranker that follows loop-back edges raises the header's rank
   * forever. This test would not fail — it would hang — which is exactly why it
   * is worth writing down.
   */
  it('ranks a loop without following its loop-back edge', () => {
    const graph = buildSelectionGraph('while (go) { step(); more() }')
    expect(graph.edges.some((e) => e.kind === 'loop-back')).toBe(true)

    const layout = layoutGraph(graph, OPEN)
    expectSane(layout, graph)
    expect(layout.hiddenCount).toBe(0)

    const header = graph.nodes.find((n) => n.kind === 'while')
    const body = graph.nodes.find((n) => n.label === 'Call: step()')
    expect(header).toBeDefined()
    expect(body).toBeDefined()
    if (header === undefined || body === undefined) return

    // The body is downstream of the header; the loop-back must not have pushed
    // the header past it.
    expect(rankOf(layout, header.id)).toBeLessThan(rankOf(layout, body.id))
  })

  /**
   * `function f() { f() }` is legal and common. The builder records direct
   * recursion on `callees` rather than as an edge, so this shape is built by
   * hand — a self-edge must rank, place and route without looping.
   */
  it('terminates on direct recursion and still draws the self-edge', () => {
    const graph = graphOf([node('f', { kind: 'function' })], [edge('f', 'f', 'calls')])

    const layout = layoutGraph(graph, OPEN)
    expectSane(layout, graph)

    expect(layout.nodes).toHaveLength(1)
    expect(layout.edges).toHaveLength(1)

    const self = layout.edges[0]
    expect(self).toBeDefined()
    if (self === undefined) return

    // A collapsed self-loop is a zero-length path: present in the DOM, invisible
    // on screen. It has to have real horizontal extent.
    const xs = coordinatesIn(self.path).filter((_, index) => index % 2 === 0)
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0)
  })

  /** A mutual-recursion cycle survives the loop-back filter, so it needs its own guard. */
  it('terminates on a calls cycle that no loop-back edge covers', () => {
    const graph = graphOf(
      [node('a', { kind: 'function' }), node('b', { kind: 'function' })],
      [edge('a', 'b', 'calls'), edge('b', 'a', 'calls')]
    )

    const layout = layoutGraph(graph, OPEN)
    expectSane(layout, graph)
    expect(idsOf(layout).slice().sort()).toEqual(['a', 'b'])
    expect(layout.edges).toHaveLength(2)
  })

  it('places every node of a real graph when the limits are generous', () => {
    const graph = buildFileGraph(
      [
        'export function alpha() { beta(); console.log(1) }',
        'function beta() { for (const x of xs) { gamma(x) } }',
        'function gamma(x) { return x }',
        'class Holder { one() { return this.two() } two() { return 2 } }'
      ].join('\n')
    )

    const layout = layoutGraph(graph, OPEN)
    expectSane(layout, graph)

    expect(layout.hiddenCount).toBe(0)
    expect(idsOf(layout).slice().sort()).toEqual(graph.nodes.map((n) => n.id).slice().sort())
  })

  /**
   * File mode routinely produces fragments that share no edge at all — two
   * unrelated top-level functions, a class nobody calls. Dropping them would
   * leave a diagram that looks complete and is not.
   */
  it('places disconnected components instead of dropping them', () => {
    const graph = graphOf(
      [node('a1'), node('a2'), node('b1'), node('b2'), node('lonely')],
      [edge('a1', 'a2'), edge('b1', 'b2')]
    )

    const layout = layoutGraph(graph, OPEN)
    expectSane(layout, graph)

    expect(idsOf(layout).slice().sort()).toEqual(['a1', 'a2', 'b1', 'b2', 'lonely'])
    expect(layout.hiddenCount).toBe(0)
    // Each component starts its own chain at column 0 rather than being queued
    // after the previous one, which would make the drawing absurdly wide.
    expect(rankOf(layout, 'b1')).toBe(0)
    expect(rankOf(layout, 'lonely')).toBe(0)
  })

  /** Longest path, not shortest: a node sits right of its *deepest* predecessor. */
  it('ranks a diamond by its longest path', () => {
    const graph = graphOf(
      [node('root'), node('short'), node('mid'), node('join')],
      [edge('root', 'short'), edge('root', 'mid'), edge('mid', 'short'), edge('short', 'join')]
    )

    const layout = layoutGraph(graph, OPEN)
    expectSane(layout, graph)

    expect(rankOf(layout, 'root')).toBe(0)
    expect(rankOf(layout, 'mid')).toBe(1)
    expect(rankOf(layout, 'short')).toBe(2)
    expect(rankOf(layout, 'join')).toBe(3)
    expect(layout.depth).toBe(4)
  })
})

describe('depth and fan-out limits', () => {
  it('omits nodes past maxDepth and reports them as hidden', () => {
    const chain = ['n0', 'n1', 'n2', 'n3', 'n4', 'n5']
    const graph = graphOf(
      chain.map((id) => node(id)),
      chain.slice(1).map((id, index) => edge(chain[index] ?? '', id))
    )

    const open = layoutGraph(graph, OPEN)
    expectSane(open, graph)
    expect(open.nodes).toHaveLength(6)
    expect(open.hiddenCount).toBe(0)

    const shallow = layoutGraph(graph, { maxDepth: 3, fanOut: 40 })
    expectSane(shallow, graph)

    expect(shallow.nodes.length).toBeLessThan(open.nodes.length)
    expect(idsOf(shallow)).toEqual(['n0', 'n1', 'n2'])
    expect(shallow.hiddenCount).toBe(3)
    expect(shallow.depth).toBe(3)
  })

  it('collapses an over-wide rank into exactly one overflow node', () => {
    const children = Array.from({ length: 10 }, (_, index) => `c${index}`)
    const graph = graphOf(
      [node('root'), ...children.map((id) => node(id))],
      children.map((id) => edge('root', id))
    )

    const layout = layoutGraph(graph, { maxDepth: 10, fanOut: 3 })
    expectSane(layout, graph)

    const overflow = layout.nodes.filter((laid) => laid.isOverflow)
    expect(overflow).toHaveLength(1)
    expect(overflow[0]?.node.label).toBe('+7 more')
    expect(layout.hiddenCount).toBe(7)

    // 1 root + 3 shown siblings + 1 placeholder.
    expect(layout.nodes).toHaveLength(5)
    expect(layout.nodes.filter((laid) => !laid.isOverflow)).toHaveLength(4)
  })

  /**
   * A placeholder has no source location, so nothing may treat it as a real
   * node. `isOverflow` is the flag to read; the zeroed location is only there
   * because the shape demands numbers, and every real position in this app is
   * 1-based.
   */
  it('gives the overflow placeholder no source position and no id collision', () => {
    const children = Array.from({ length: 5 }, (_, index) => `c${index}`)
    const graph = graphOf(
      [node('root'), ...children.map((id) => node(id))],
      children.map((id) => edge('root', id))
    )

    const layout = layoutGraph(graph, { maxDepth: 10, fanOut: 2 })
    const overflow = layout.nodes.find((laid) => laid.isOverflow)
    expect(overflow).toBeDefined()
    expect(overflow?.node.location.startLine).toBe(0)
    expect(overflow?.node.metrics).toBeNull()

    const ids = idsOf(layout)
    expect(new Set(ids).size).toBe(ids.length)
    expect(graph.nodes.some((n) => n.id === overflow?.node.id)).toBe(false)
  })

  /**
   * Cutting a rank orphans whatever hung off the nodes that went. Leaving those
   * children floating would draw them as roots of their own, which claims a
   * structure the code does not have — so they are hidden too, and counted.
   */
  it('hides the descendants of a node the fan-out cut', () => {
    const graph = graphOf(
      [node('root'), node('keep'), node('cut'), node('orphan')],
      [edge('root', 'keep'), edge('root', 'cut'), edge('cut', 'orphan')]
    )

    const layout = layoutGraph(graph, { maxDepth: 10, fanOut: 1 })
    expectSane(layout, graph)

    expect(idsOf(layout).filter((id) => !id.startsWith('overflow'))).toEqual(['root', 'keep'])
    expect(layout.hiddenCount).toBe(2)
    // No edge may point at a node that is not on the canvas.
    const drawn = new Set(idsOf(layout))
    for (const laid of layout.edges) {
      expect(drawn.has(laid.edge.source)).toBe(true)
      expect(drawn.has(laid.edge.target)).toBe(true)
    }
  })

  it('leaves nothing hidden when the limits are wider than the graph', () => {
    const graph = buildSelectionGraph('if (a) { one() } else { two() }')
    const layout = layoutGraph(graph, OPEN)

    expectSane(layout, graph)
    expect(layout.hiddenCount).toBe(0)
    expect(layout.nodes).toHaveLength(graph.nodes.length)
  })
})

describe('geometry', () => {
  /**
   * `NaN` in a `d` attribute is not an error the browser reports; it silently
   * draws nothing, which is indistinguishable from an edge that was never
   * emitted. Every shape the router can produce is exercised here.
   */
  it('emits no NaN for any routing case', () => {
    const samples: readonly CodeGraph[] = [
      buildSelectionGraph('while (go) { step() }'),
      buildSelectionGraph('do { tick() } while (running)'),
      buildSelectionGraph('switch (k) { case 1: a(); case 2: b(); break; default: c() }'),
      buildSelectionGraph('try { risky() } catch (e) { log(e) } finally { close() }'),
      buildFileGraph('export function a() { b(); missing() }\nfunction b() { for (;;) { a() } }'),
      graphOf([node('solo', { kind: 'function' })], [edge('solo', 'solo', 'calls')]),
      graphOf([node('x'), node('y')], [edge('x', 'y'), edge('y', 'x', 'loop-back')])
    ]

    for (const graph of samples) {
      const layout = layoutGraph(graph, OPEN)
      expectSane(layout, graph)
      expect(layout.edges.length).toBeGreaterThan(0)
    }
  })

  /**
   * A loop-back drawn as an ordinary left-to-right bezier cuts straight through
   * whatever sits between its endpoints, and a line passing through a box is
   * indistinguishable from a line connecting to it. It has to bow clear.
   */
  it('bows a loop-back above its endpoints instead of through them', () => {
    const graph = graphOf(
      [node('head'), node('body'), node('tail')],
      [edge('head', 'body'), edge('body', 'tail'), edge('tail', 'head', 'loop-back')]
    )

    const layout = layoutGraph(graph, OPEN)
    expectSane(layout, graph)

    const back = layout.edges.find((laid) => laid.edge.kind === 'loop-back')
    const forward = layout.edges.find((laid) => laid.edge.kind === 'sequential')
    expect(back).toBeDefined()
    expect(forward).toBeDefined()
    if (back === undefined || forward === undefined) return

    const topOfNodes = Math.min(...layout.nodes.map((laid) => laid.y))
    const backYs = coordinatesIn(back.path).filter((_, index) => index % 2 === 1)

    // The crest clears every box, so the curve cannot cross one.
    expect(Math.min(...backYs)).toBeLessThan(topOfNodes)
    // ...and an ordinary edge does not do that.
    const forwardYs = coordinatesIn(forward.path).filter((_, index) => index % 2 === 1)
    expect(Math.min(...forwardYs)).toBeGreaterThanOrEqual(topOfNodes)
  })

  /**
   * The barycentre pass. Declaration order here deliberately crosses the two
   * edges over each other; ordering each child next to its parent uncrosses
   * them. This is one pass, not a crossing minimiser — it fixes the obvious case
   * and makes no claim about the hard ones.
   */
  it('orders a rank by its parents to uncross edges', () => {
    const graph = graphOf(
      [node('top'), node('bottom'), node('childOfBottom'), node('childOfTop')],
      [edge('top', 'childOfTop'), edge('bottom', 'childOfBottom')]
    )

    const layout = layoutGraph(graph, OPEN)
    expectSane(layout, graph)

    const y = (id: string): number => layout.nodes.find((laid) => laid.node.id === id)?.y ?? -1
    expect(y('top')).toBeLessThan(y('bottom'))
    // Declared second but drawn first, because its parent is the upper one.
    expect(y('childOfTop')).toBeLessThan(y('childOfBottom'))
  })

  it('keeps every box inside the reported bounding box', () => {
    const graph = buildFileGraph(
      [
        '/** Documented. */',
        'export async function outer(a: number, b: string): Promise<void> {',
        '  if (a) { inner(b) } else { other() }',
        '  while (a) { inner(a) }',
        '}',
        'function inner(v) { return v }',
        'function other() { throw new Error("x") }'
      ].join('\n')
    )

    const layout = layoutGraph(graph, OPEN)
    expectSane(layout, graph)

    expect(layout.width).toBeGreaterThan(0)
    expect(layout.height).toBeGreaterThan(0)
    // Boxes in one column must not overlap each other vertically.
    for (const column of new Set(layout.nodes.map((laid) => laid.rank))) {
      const stacked = layout.nodes
        .filter((laid) => laid.rank === column)
        .sort((a, b) => a.y - b.y)
      for (let i = 1; i < stacked.length; i++) {
        const above = stacked[i - 1]
        const below = stacked[i]
        if (above === undefined || below === undefined) continue
        expect(below.y).toBeGreaterThanOrEqual(above.y + above.height)
      }
    }
  })

  /** Width tracks the label; the clamps stop a long one from becoming a banner. */
  it('sizes boxes from the label and clamps both ends', () => {
    const graph = graphOf(
      [node('tiny', { label: 'x' }), node('huge', { label: 'y'.repeat(200) })],
      []
    )

    const layout = layoutGraph(graph, OPEN)
    expectSane(layout, graph)

    const tiny = layout.nodes.find((laid) => laid.node.id === 'tiny')
    const huge = layout.nodes.find((laid) => laid.node.id === 'huge')
    expect(tiny?.width).toBeGreaterThan(0)
    expect(huge?.width).toBeGreaterThan(tiny?.width ?? 0)
    expect(huge?.width).toBeLessThan(400)
  })

  /** Metrics add a second text row, so those boxes must be taller. */
  it('makes a metric-carrying node taller than a bare one', () => {
    const graph = graphOf(
      [
        node('bare', { kind: 'function' }),
        node('measured', {
          kind: 'function',
          metrics: { cyclomaticComplexity: 3, lineCount: 12, paramCount: 2 }
        })
      ],
      []
    )

    const layout = layoutGraph(graph, OPEN)
    const bare = layout.nodes.find((laid) => laid.node.id === 'bare')
    const measured = layout.nodes.find((laid) => laid.node.id === 'measured')
    expect(measured?.height).toBeGreaterThan(bare?.height ?? 0)
  })

  it('is deterministic — the same graph and options give byte-identical output', () => {
    const graph = buildFileGraph('export function a() { b() }\nfunction b() { a(); c() }\nfunction c() {}')
    expect(JSON.stringify(layoutGraph(graph, OPEN))).toBe(JSON.stringify(layoutGraph(graph, OPEN)))
  })
})

describe('degenerate input', () => {
  it('returns a zero-size layout for an empty graph without throwing', () => {
    const graph = buildSelectionGraph('   ')
    expect(graph.nodes).toHaveLength(0)

    const layout = layoutGraph(graph, OPEN)
    expect(layout.nodes).toHaveLength(0)
    expect(layout.edges).toHaveLength(0)
    expect(layout.width).toBe(0)
    expect(layout.height).toBe(0)
    expect(layout.depth).toBe(0)
    expect(layout.hiddenCount).toBe(0)
  })

  /**
   * This runs on every debounced cursor move, so it sees transiently broken
   * source, stale persisted options and graphs the builder degraded to its
   * line-per-node fallback. None of that may throw.
   */
  it('never throws on hostile graphs or hostile options', () => {
    const graphs: readonly CodeGraph[] = [
      buildSelectionGraph('function ( { { {'),
      buildSelectionGraph(''),
      buildFileGraph('x'.repeat(20000)),
      graphOf([], []),
      // Edges naming nodes that do not exist.
      graphOf([node('only')], [edge('only', 'ghost'), edge('ghost', 'only')]),
      // A three-node cycle with no loop-back edge to mark it.
      graphOf(
        [node('p'), node('q'), node('r')],
        [edge('p', 'q'), edge('q', 'r'), edge('r', 'p')]
      )
    ]

    const hostile: readonly LayoutOptions[] = [
      { maxDepth: 0, fanOut: 0 },
      { maxDepth: -5, fanOut: -1 },
      { maxDepth: 1e9, fanOut: 1e9 },
      { maxDepth: Number.NaN, fanOut: Number.NaN },
      { maxDepth: Number.POSITIVE_INFINITY, fanOut: 2.7 }
    ]

    for (const graph of graphs) {
      for (const options of [...hostile, OPEN]) {
        expect(() => layoutGraph(graph, options)).not.toThrow()
        expectSane(layoutGraph(graph, options), graph)
      }
    }
  })

  /**
   * A `maxDepth` of 1 is the narrowest legal setting: the roots and nothing
   * else. It must still draw, and must still say how much it is not showing.
   */
  it('draws only the roots at maxDepth 1 and says how many it hid', () => {
    const graph = buildSelectionGraph('if (a) { one() } else { two() }')
    const layout = layoutGraph(graph, { maxDepth: 1, fanOut: 40 })

    expectSane(layout, graph)
    expect(layout.depth).toBe(1)
    expect(layout.nodes.length).toBeGreaterThan(0)
    expect(layout.hiddenCount).toBeGreaterThan(0)
  })

  /**
   * A node listed twice would be placed twice and would overwrite itself in
   * every lookup table the engine keeps, so the duplicate is dropped. It is the
   * one case where `hiddenCount` cannot balance against `graph.nodes.length` —
   * the second entry was never a distinct node to begin with.
   */
  it('drops a duplicated id rather than placing it twice', () => {
    const graph = graphOf([node('dup'), node('dup'), node('other')], [edge('dup', 'other')])

    const layout = layoutGraph(graph, OPEN)
    expect(idsOf(layout).slice().sort()).toEqual(['dup', 'other'])
  })

  /**
   * The ranking DFS carries an explicit stack rather than recursing, and this is
   * the test that says why. A deep chain — the shape the builder's line-per-node
   * fallback and any long straight-line function produce — is a recursion as
   * deep as the graph is long, and V8's stack gives out well before this.
   */
  it('survives a chain far deeper than the call stack allows', () => {
    const length = 20000
    const ids = Array.from({ length }, (_, index) => `line${index}`)
    const graph = graphOf(
      ids.map((id) => node(id)),
      ids.slice(1).map((id, index) => edge(ids[index] ?? '', id))
    )

    const layout = layoutGraph(graph, OPEN)
    expectSane(layout, graph)

    // The depth limit is what keeps the drawing finite; everything past it is
    // reported rather than quietly dropped.
    expect(layout.depth).toBe(10)
    expect(layout.nodes).toHaveLength(10)
    expect(layout.hiddenCount).toBe(length - 10)
  })
})
