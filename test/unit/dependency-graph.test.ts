import { describe, expect, it } from 'vitest'
import {
  assignComponents,
  createGraph,
  cycleFor,
  dependentsOf,
  edgeCount,
  invalidationSet,
  removeNode,
  stronglyConnectedComponents,
  upsertNode,
  type DependencyGraph
} from '../../src/shared/dependency-graph'

/** Builds a graph from an adjacency description: `{ 'a.ts': ['b.ts'] }`. */
function graphOf(edges: Record<string, readonly string[]>): DependencyGraph {
  const graph = createGraph()
  for (const [relativePath, imports] of Object.entries(edges)) {
    upsertNode(graph, { relativePath, imports })
  }
  return graph
}

const importsOf = (graph: DependencyGraph, path: string): string[] =>
  [...(graph.nodes.get(path)?.imports ?? [])].sort()

const importedByOf = (graph: DependencyGraph, path: string): string[] =>
  [...(graph.nodes.get(path)?.importedBy ?? [])].sort()

describe('upsertNode', () => {
  it('records forward and reverse edges together', () => {
    const graph = graphOf({ 'a.ts': ['b.ts'] })

    expect(importsOf(graph, 'a.ts')).toEqual(['b.ts'])
    expect(importedByOf(graph, 'b.ts')).toEqual(['a.ts'])
  })

  it('creates a node for an edge target that has not been walked yet', () => {
    const graph = graphOf({ 'a.ts': ['not-yet-parsed.ts'] })

    // Otherwise the reverse edge is lost until the target happens to be
    // visited, and a change to it would invalidate nothing.
    expect(graph.nodes.has('not-yet-parsed.ts')).toBe(true)
    expect(importedByOf(graph, 'not-yet-parsed.ts')).toEqual(['a.ts'])
  })

  /**
   * The classic reverse-index leak. If a dropped import does not remove the
   * matching reverse edge, the invalidation set widens with every edit until
   * each save rechecks the entire workspace.
   */
  it('removes the stale reverse edge when an import is dropped', () => {
    const graph = graphOf({ 'a.ts': ['b.ts', 'c.ts'] })
    expect(importedByOf(graph, 'b.ts')).toEqual(['a.ts'])

    upsertNode(graph, { relativePath: 'a.ts', imports: ['c.ts'] })

    expect(importsOf(graph, 'a.ts')).toEqual(['c.ts'])
    expect(importedByOf(graph, 'b.ts')).toEqual([])
    expect(importedByOf(graph, 'c.ts')).toEqual(['a.ts'])
  })

  it('leaves untouched edges alone when re-upserting', () => {
    const graph = graphOf({ 'a.ts': ['b.ts'], 'z.ts': ['b.ts'] })
    upsertNode(graph, { relativePath: 'a.ts', imports: ['b.ts', 'c.ts'] })

    expect(importedByOf(graph, 'b.ts')).toEqual(['a.ts', 'z.ts'])
  })

  it('is idempotent', () => {
    const graph = graphOf({ 'a.ts': ['b.ts'] })
    upsertNode(graph, { relativePath: 'a.ts', imports: ['b.ts'] })

    expect(importsOf(graph, 'a.ts')).toEqual(['b.ts'])
    expect(importedByOf(graph, 'b.ts')).toEqual(['a.ts'])
    expect(edgeCount(graph)).toBe(1)
  })

  it('records mtime when given, and leaves it alone when not', () => {
    const graph = createGraph()
    upsertNode(graph, { relativePath: 'a.ts', imports: [], mtimeMs: 1234 })
    expect(graph.nodes.get('a.ts')?.mtimeMs).toBe(1234)

    upsertNode(graph, { relativePath: 'a.ts', imports: ['b.ts'] })
    expect(graph.nodes.get('a.ts')?.mtimeMs).toBe(1234)
  })
})

describe('removeNode', () => {
  it('drops every reverse edge pointing out of the removed node', () => {
    const graph = graphOf({ 'a.ts': ['b.ts'] })
    removeNode(graph, 'a.ts')

    expect(graph.nodes.has('a.ts')).toBe(false)
    expect(importedByOf(graph, 'b.ts')).toEqual([])
  })

  /**
   * A dependent's import statement still exists in its source, so the edge is
   * real and the resulting "cannot find module" is a true diagnostic.
   */
  it('leaves a dependent pointing at the deleted path', () => {
    const graph = graphOf({ 'a.ts': ['b.ts'] })
    removeNode(graph, 'b.ts')

    expect(importsOf(graph, 'a.ts')).toEqual(['b.ts'])
    expect(graph.nodes.has('b.ts')).toBe(false)
  })

  it('survives traversal after a removal rather than crashing on a dangling edge', () => {
    const graph = graphOf({ 'a.ts': ['b.ts'], 'b.ts': ['c.ts'] })
    removeNode(graph, 'b.ts')

    expect(() => dependentsOf(graph, 'c.ts')).not.toThrow()
    expect(() => stronglyConnectedComponents(graph)).not.toThrow()
    expect(dependentsOf(graph, 'c.ts')).toEqual([])
  })

  it('reports whether anything was removed', () => {
    const graph = graphOf({ 'a.ts': [] })
    expect(removeNode(graph, 'a.ts')).toBe(true)
    expect(removeNode(graph, 'a.ts')).toBe(false)
  })
})

describe('dependentsOf', () => {
  it('is transitive and nearest-first', () => {
    // c imports b imports a. Changing a affects b directly, then c.
    const graph = graphOf({ 'b.ts': ['a.ts'], 'c.ts': ['b.ts'] })

    expect(dependentsOf(graph, 'a.ts')).toEqual(['b.ts', 'c.ts'])
  })

  it('excludes the queried file itself', () => {
    const graph = graphOf({ 'b.ts': ['a.ts'] })
    expect(dependentsOf(graph, 'a.ts')).not.toContain('a.ts')
  })

  it('terminates on a cycle instead of looping forever', () => {
    const graph = graphOf({ 'a.ts': ['b.ts'], 'b.ts': ['a.ts'] })

    expect(dependentsOf(graph, 'a.ts')).toEqual(['b.ts'])
    expect(dependentsOf(graph, 'b.ts')).toEqual(['a.ts'])
  })

  it('returns nothing for an unknown path', () => {
    expect(dependentsOf(createGraph(), 'nope.ts')).toEqual([])
  })

  it('does not cross into unrelated subtrees', () => {
    const graph = graphOf({ 'b.ts': ['a.ts'], 'y.ts': ['x.ts'] })
    expect(dependentsOf(graph, 'a.ts')).toEqual(['b.ts'])
  })

  it('knows nothing about a removed node, so callers must ask before removing', () => {
    const graph = graphOf({ 'b.ts': ['a.ts'] })
    expect(dependentsOf(graph, 'a.ts')).toEqual(['b.ts'])

    removeNode(graph, 'a.ts')

    // The reverse edges die with the node. This is pinned rather than merely
    // true because `applyChanges` in the compiler worker depends on it: it must
    // capture dependents BEFORE removing, and reordering those two lines would
    // otherwise silently stop deleted files from invalidating their importers.
    expect(dependentsOf(graph, 'a.ts')).toEqual([])
  })
})

describe('invalidationSet', () => {
  it('includes the changed file and everything above it', () => {
    const graph = graphOf({ 'b.ts': ['a.ts'], 'c.ts': ['b.ts'] })
    expect(invalidationSet(graph, ['a.ts']).sort()).toEqual(['a.ts', 'b.ts', 'c.ts'])
  })

  /**
   * A watcher batch has no meaningful order. If the result depended on it, the
   * order diagnostics arrive in would vary run-to-run for identical edits.
   */
  it('is identical regardless of the order the changes arrive in', () => {
    const graph = graphOf({ 'b.ts': ['a.ts'], 'c.ts': ['b.ts'], 'z.ts': ['a.ts'] })

    expect(invalidationSet(graph, ['a.ts', 'z.ts'])).toEqual(
      invalidationSet(graph, ['z.ts', 'a.ts'])
    )
  })

  it('deduplicates when two changed files share a dependent', () => {
    const graph = graphOf({ 'app.ts': ['a.ts', 'b.ts'] })
    const result = invalidationSet(graph, ['a.ts', 'b.ts'])

    expect(result.filter((path) => path === 'app.ts')).toHaveLength(1)
  })

  it('handles a changed file that is not in the graph', () => {
    const graph = graphOf({ 'a.ts': [] })
    expect(invalidationSet(graph, ['brand-new.ts'])).toEqual(['brand-new.ts'])
  })

  it('returns nothing for no changes', () => {
    expect(invalidationSet(graphOf({ 'a.ts': [] }), [])).toEqual([])
  })
})

describe('stronglyConnectedComponents / assignComponents', () => {
  it('finds a two-file cycle', () => {
    const graph = graphOf({ 'a.ts': ['b.ts'], 'b.ts': ['a.ts'] })
    const cycles = assignComponents(graph)

    expect(cycles).toHaveLength(1)
    expect(cycles[0]?.members).toEqual(['a.ts', 'b.ts'])
  })

  it('finds a three-file cycle and ignores an unrelated file', () => {
    const graph = graphOf({
      'a.ts': ['b.ts'],
      'b.ts': ['c.ts'],
      'c.ts': ['a.ts'],
      'd.ts': []
    })
    const cycles = assignComponents(graph)

    expect(cycles).toHaveLength(1)
    expect(cycles[0]?.members).toEqual(['a.ts', 'b.ts', 'c.ts'])
    expect(graph.nodes.get('d.ts')?.componentId).toBe('d.ts')
  })

  it('reports a self-import as a cycle', () => {
    const graph = graphOf({ 'a.ts': ['a.ts'] })
    const cycles = assignComponents(graph)

    expect(cycles).toHaveLength(1)
    expect(cycles[0]?.members).toEqual(['a.ts'])
  })

  it('does not report an ordinary single file as a cycle', () => {
    const graph = graphOf({ 'a.ts': ['b.ts'], 'b.ts': [] })
    expect(assignComponents(graph)).toEqual([])
  })

  it('reports two disjoint cycles separately', () => {
    const graph = graphOf({
      'a.ts': ['b.ts'],
      'b.ts': ['a.ts'],
      'x.ts': ['y.ts'],
      'y.ts': ['x.ts']
    })
    const cycles = assignComponents(graph)

    expect(cycles).toHaveLength(2)
    expect(cycles.map((cycle) => cycle.id)).toEqual(['a.ts', 'x.ts'])
  })

  it('gives every member of a cycle the same, insertion-order-independent id', () => {
    const forward = graphOf({ 'b.ts': ['a.ts'], 'a.ts': ['b.ts'] })
    const backward = graphOf({ 'a.ts': ['b.ts'], 'b.ts': ['a.ts'] })

    assignComponents(forward)
    assignComponents(backward)

    expect(forward.nodes.get('a.ts')?.componentId).toBe('a.ts')
    expect(forward.nodes.get('b.ts')?.componentId).toBe('a.ts')
    expect(backward.nodes.get('a.ts')?.componentId).toBe(
      forward.nodes.get('a.ts')?.componentId
    )
  })

  it('finds no cycles in a large DAG', () => {
    const graph = createGraph()
    for (let i = 0; i < 1000; i++) {
      upsertNode(graph, { relativePath: `f${i}.ts`, imports: i > 0 ? [`f${i - 1}.ts`] : [] })
    }
    expect(assignComponents(graph)).toEqual([])
  })

  /**
   * The entire reason Tarjan is iterative here. The recursive form overflows
   * the stack on a deep chain, and this is the test that catches a well-meaning
   * rewrite back to the shorter version.
   */
  it('walks a 50 000-node chain without throwing RangeError', () => {
    const graph = createGraph()
    for (let i = 0; i < 50_000; i++) {
      upsertNode(graph, { relativePath: `f${i}.ts`, imports: i > 0 ? [`f${i - 1}.ts`] : [] })
    }

    expect(() => assignComponents(graph)).not.toThrow()
    expect(assignComponents(graph)).toEqual([])
  })

  it('handles a deep chain that ends in a cycle', () => {
    const graph = createGraph()
    for (let i = 0; i < 5000; i++) {
      upsertNode(graph, { relativePath: `f${i}.ts`, imports: i > 0 ? [`f${i - 1}.ts`] : [] })
    }
    // Close the loop at the bottom.
    upsertNode(graph, { relativePath: 'f0.ts', imports: ['f4999.ts'] })

    const cycles = assignComponents(graph)
    expect(cycles).toHaveLength(1)
    expect(cycles[0]?.members).toHaveLength(5000)
  })

  it('clears the dirty flag, which mutations set', () => {
    const graph = graphOf({ 'a.ts': ['b.ts'] })
    expect(graph.dirty).toBe(true)

    assignComponents(graph)
    expect(graph.dirty).toBe(false)

    upsertNode(graph, { relativePath: 'c.ts', imports: [] })
    expect(graph.dirty).toBe(true)
  })

  it('ignores edges pointing at deleted files', () => {
    const graph = graphOf({ 'a.ts': ['gone.ts'] })
    removeNode(graph, 'gone.ts')

    expect(() => assignComponents(graph)).not.toThrow()
    expect(assignComponents(graph)).toEqual([])
  })
})

describe('helpers', () => {
  it('counts forward edges', () => {
    expect(edgeCount(graphOf({ 'a.ts': ['b.ts', 'c.ts'], 'b.ts': ['c.ts'] }))).toBe(3)
  })

  it('finds the cycle a file belongs to', () => {
    const graph = graphOf({ 'a.ts': ['b.ts'], 'b.ts': ['a.ts'], 'z.ts': [] })
    const cycles = assignComponents(graph)

    expect(cycleFor(cycles, 'b.ts')?.members).toEqual(['a.ts', 'b.ts'])
    expect(cycleFor(cycles, 'z.ts')).toBeNull()
  })
})
