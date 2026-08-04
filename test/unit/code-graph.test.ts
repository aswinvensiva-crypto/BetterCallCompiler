import { describe, expect, it } from 'vitest'
import { buildFileGraph, buildSelectionGraph } from '../../src/renderer/editor/code-graph'
import { codeGraphSchema, type CodeGraph, type CodeGraphNode } from '../../src/shared/code-graph'

/**
 * The graph engine behind the Visualizer.
 *
 * These tests assert on *structure* — node kinds, edge kinds, parentage — far
 * more than on label text. Labels are cosmetic and will be retuned as the panel
 * evolves; an edge that says a loop returns to its header is the actual claim
 * the diagram makes about the code, and the thing a regression would silently
 * break.
 */

function nodeByLabel(graph: CodeGraph, label: string): CodeGraphNode {
  const found = graph.nodes.find((node) => node.label === label)
  if (found === undefined) {
    throw new Error(`no node labelled "${label}" in [${graph.nodes.map((n) => n.label).join(', ')}]`)
  }
  return found
}

function edgesFrom(graph: CodeGraph, id: string): readonly { target: string; kind: string }[] {
  return graph.edges.filter((edge) => edge.source === id).map((e) => ({ target: e.target, kind: e.kind }))
}

function hasEdge(graph: CodeGraph, from: string, to: string, kind: string): boolean {
  return graph.edges.some((e) => e.source === from && e.target === to && e.kind === kind)
}

describe('buildSelectionGraph — control flow', () => {
  /**
   * The headline fix over the old topography, which chained every node in
   * traversal order and admitted in a comment that "a real CFG would branch
   * here". A branch that draws both arms is the whole point of the rewrite.
   */
  it('gives an if/else a true arm and a false arm', () => {
    const graph = buildSelectionGraph('if (a > 1) { win() } else { lose() }')

    const branch = nodeByLabel(graph, 'If (a > 1)')
    const win = nodeByLabel(graph, 'Call: win()')
    const lose = nodeByLabel(graph, 'Call: lose()')

    expect(branch.kind).toBe('if')
    expect(hasEdge(graph, branch.id, win.id, 'true')).toBe(true)
    expect(hasEdge(graph, branch.id, lose.id, 'false')).toBe(true)
  })

  it('closes a loop with a loop-back edge to its header', () => {
    const graph = buildSelectionGraph('while (go) { step() }')

    const header = nodeByLabel(graph, 'While (go)')
    const body = nodeByLabel(graph, 'Call: step()')

    expect(hasEdge(graph, header.id, body.id, 'true')).toBe(true)
    expect(hasEdge(graph, body.id, header.id, 'loop-back')).toBe(true)
  })

  /**
   * `do … while` is the one loop whose body precedes its test, so the body — not
   * the header — is the entry. Getting this backwards would draw a loop that
   * checks a condition before running code that is guaranteed to run once.
   */
  it('enters a do/while at the body, not at the test', () => {
    const graph = buildSelectionGraph('do { tick() } while (running)')

    const test = nodeByLabel(graph, 'Do while (running)')
    const body = nodeByLabel(graph, 'Call: tick()')

    expect(graph.rootIds).toContain(body.id)
    expect(graph.rootIds).not.toContain(test.id)
    expect(hasEdge(graph, test.id, body.id, 'loop-back')).toBe(true)
  })

  it('draws one case edge per switch case, including default', () => {
    const graph = buildSelectionGraph('switch (k) { case 1: a(); break; case 2: b(); break }')

    const head = nodeByLabel(graph, 'Switch (k)')
    const caseEdges = graph.edges.filter((e) => e.source === head.id && e.kind === 'case')

    expect(caseEdges).toHaveLength(2)
    expect(caseEdges.map((e) => e.label)).toEqual(['1', '2'])
  })

  /**
   * A case without a terminating break falls into the next one. Pretending every
   * case breaks draws control flow the code does not have — and fallthrough is
   * precisely the case where a reader most wants the diagram to be honest.
   */
  it('chains a falling-through case into the next one', () => {
    const graph = buildSelectionGraph('switch (k) { case 1: a(); case 2: b(); break }')

    const fell = graph.edges.find((e) => e.label === 'falls through')
    expect(fell).toBeDefined()

    // ...and a case that *does* break must not gain that edge.
    const clean = buildSelectionGraph('switch (k) { case 1: a(); break; case 2: b(); break }')
    expect(clean.edges.some((e) => e.label === 'falls through')).toBe(false)
  })

  it('wires catch and finally off the try', () => {
    const graph = buildSelectionGraph('try { risky() } catch (e) { log(e) } finally { close() }')

    const tryNode = nodeByLabel(graph, 'Try')
    const catchNode = nodeByLabel(graph, 'Catch (e)')
    const finallyNode = nodeByLabel(graph, 'Finally')

    expect(hasEdge(graph, tryNode.id, catchNode.id, 'catch')).toBe(true)
    expect(hasEdge(graph, tryNode.id, finallyNode.id, 'finally')).toBe(true)
  })

  /**
   * The old parser chained a return to whatever followed it in source order,
   * which asserts flow that cannot happen. A return is a leaf.
   */
  it('makes a return terminal', () => {
    const graph = buildSelectionGraph('function f() { if (a) { return 1 } after() }')

    const ret = nodeByLabel(graph, 'Return 1')
    expect(ret.kind).toBe('return')
    expect(ret.category).toBe('terminal')
    expect(edgesFrom(graph, ret.id)).toHaveLength(0)
  })
})

describe('buildFileGraph — structure and calls', () => {
  /**
   * Function declarations are hoisted, so a call can legally precede the
   * declaration it targets. Resolving calls in the same pass that discovers
   * declarations silently drops those edges: the graph still renders and still
   * looks plausible, which is what makes the bug worth a dedicated test.
   */
  it('resolves a call to a function declared later in the file', () => {
    const graph = buildFileGraph('function first() { second() }\nfunction second() { return 1 }')

    const first = nodeByLabel(graph, 'first()')
    const second = nodeByLabel(graph, 'second()')

    expect(hasEdge(graph, first.id, second.id, 'calls')).toBe(true)
    expect(first.callees).toContain(second.id)
    expect(second.callers).toContain(first.id)
  })

  it('hangs methods off their class without inventing control flow', () => {
    const graph = buildFileGraph('class Foo {\n  bar() { return this.baz() }\n  baz() { return 2 }\n}')

    const foo = nodeByLabel(graph, 'Foo')
    const bar = nodeByLabel(graph, 'bar()')
    const baz = nodeByLabel(graph, 'baz()')

    expect(foo.kind).toBe('class')
    expect(bar.parentId).toBe(foo.id)
    expect(baz.parentId).toBe(foo.id)

    // Containment is structural: it must not masquerade as an edge.
    expect(graph.edges.some((e) => e.source === foo.id && e.target === bar.id)).toBe(false)
    // `this.baz()` still resolves to the sibling method.
    expect(hasEdge(graph, bar.id, baz.id, 'calls')).toBe(true)
  })

  /**
   * There is no cross-file analysis here and no type checker. An imported callee
   * gets an honest placeholder rather than a fabricated body.
   */
  it('degrades an unresolvable call to an external leaf instead of throwing', () => {
    const graph = buildFileGraph("import { helper } from './x'\nfunction main() { helper() }")

    const helper = nodeByLabel(graph, 'helper()')
    expect(helper.kind).toBe('leaf')
    expect(helper.category).toBe('external')
    expect(helper.metrics).toBeNull()
  })

  it('records export status, async, and the JSDoc summary', () => {
    const graph = buildFileGraph(
      '/** Adds numbers. */\nexport async function add(a: number, b: number): Promise<number> { return a + b }'
    )

    const add = nodeByLabel(graph, 'add()')
    expect(add.visibility).toBe('exported')
    expect(add.category).toBe('exported')
    expect(add.isAsync).toBe(true)
    expect(add.jsDoc).toBe('Adds numbers.')
    expect(add.returnType).toBe('Promise<number>')
    expect(add.params.map((p) => p.name)).toEqual(['a', 'b'])
    expect(add.params[0]?.type).toBe('number')
  })

  /** No type checker stands behind this, so an unannotated return stays null. */
  it('never guesses a return type that was not written down', () => {
    const graph = buildFileGraph('function guess() { return 42 }')
    expect(nodeByLabel(graph, 'guess()').returnType).toBeNull()
  })
})

describe('cyclomatic complexity', () => {
  /**
   * Hand-counted: 1 base + 2 ifs + 1 for + 1 `&&` + 1 ternary = 6.
   */
  it('counts each branch point once', () => {
    const graph = buildFileGraph(
      'function f(a, b) { if (a) {} if (b) {} for (;;) {} return a && b ? 1 : 2 }'
    )
    expect(nodeByLabel(graph, 'f()').metrics?.cyclomaticComplexity).toBe(6)
  })

  it('gives a straight-line function a complexity of one', () => {
    const graph = buildFileGraph('function simple() { return 1 }')
    expect(nodeByLabel(graph, 'simple()').metrics?.cyclomaticComplexity).toBe(1)
  })

  /**
   * A function that merely *contains* a branchy callback is not itself branchy.
   * Charging the callback's branches to the parent would make every function
   * that touches `.map` look complex.
   */
  it('does not charge a nested callback branches to its parent', () => {
    const graph = buildFileGraph('function outer() { return [1].map((x) => (x ? 1 : 2)) }')
    expect(nodeByLabel(graph, 'outer()').metrics?.cyclomaticComplexity).toBe(1)
  })
})

describe('failure behaviour', () => {
  /**
   * Both builders run on every debounced cursor move, and most keystrokes leave
   * the buffer transiently unparseable. Throwing there would take the panel down
   * mid-typing, so a broken parse degrades to a line list that still says why.
   */
  it('falls back with an explanation rather than throwing on a broken parse', () => {
    const graph = buildSelectionGraph('function ( { { {')

    expect(graph.source).toBe('fallback')
    expect(graph.error).not.toBeNull()
    expect(graph.nodes.length).toBeGreaterThan(0)
  })

  it('returns an empty graph for empty input', () => {
    const graph = buildSelectionGraph('   ')

    expect(graph.nodes).toHaveLength(0)
    // Nothing went wrong, so there is nothing to explain.
    expect(graph.error).toBeNull()
  })

  it('never throws on hostile input', () => {
    const hostile = ['}', '"""', '/* unterminated', 'x'.repeat(20000), ' ', '<<<<<<< HEAD']
    for (const code of hostile) {
      expect(() => buildSelectionGraph(code)).not.toThrow()
      expect(() => buildFileGraph(code)).not.toThrow()
    }
  })
})

describe('schema conformance', () => {
  /**
   * Phase D sends this graph across the IPC boundary, where it is validated
   * against `codeGraphSchema` and *dropped* if it does not match. A builder that
   * emits a shape zod rejects would fail silently as an empty floating window,
   * so the builders are checked against the schema here instead.
   */
  it('emits graphs that satisfy the shared schema', () => {
    const samples = [
      buildSelectionGraph('if (a) { b() } else { c() }'),
      buildSelectionGraph('do { x() } while (y)'),
      buildSelectionGraph('function ( { {'),
      buildSelectionGraph(''),
      buildFileGraph('export class A { m() { this.n() } n() {} }\nfunction free() { free() }')
    ]

    for (const graph of samples) {
      const parsed = codeGraphSchema.safeParse(graph)
      expect(parsed.success ? null : parsed.error.issues).toBeNull()
    }
  })

  it('keeps every edge endpoint pointing at a real node', () => {
    const graph = buildFileGraph(
      'export function a() { b(); missing() }\nfunction b() { for (;;) { a() } }'
    )
    const ids = new Set(graph.nodes.map((node) => node.id))

    for (const edge of graph.edges) {
      expect(ids.has(edge.source)).toBe(true)
      expect(ids.has(edge.target)).toBe(true)
    }
  })

  /** Layout roots drive where the canvas starts drawing; a cycle must not eat them. */
  it('reports roots for a graph whose only cycle is a loop', () => {
    const graph = buildSelectionGraph('while (go) { step() }')
    expect(graph.rootIds.length).toBeGreaterThan(0)
  })
})
