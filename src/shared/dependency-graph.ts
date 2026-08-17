/**
 * The workspace import graph.
 *
 * Pure by construction: no node, no electron, no typescript, no DOM. It deals
 * in workspace-relative POSIX paths and nothing else, which is what lets the
 * interesting logic — invalidation and cycle detection — be tested without an
 * Electron window or a real filesystem.
 *
 * The one idea worth understanding: forward and reverse edges are maintained
 * *together*, on every mutation. Recomputing "who depends on this file" by
 * scanning every node would make each save O(V); keeping `importedBy` current
 * makes it O(dependents), which is the difference between a keystroke feeling
 * instant and feeling like a build.
 */

export interface GraphNode {
  readonly relativePath: string
  /** Resolved workspace-relative paths this file imports. */
  imports: Set<string>
  /** Reverse edges: files that import this one. */
  importedBy: Set<string>
  mtimeMs: number
  /**
   * The strongly-connected component this belongs to — its own path when
   * acyclic. Stale until `assignComponents` runs; see `dirty`.
   */
  componentId: string
}

export interface DependencyGraph {
  readonly nodes: Map<string, GraphNode>
  /**
   * Set by every mutation, cleared by `assignComponents`.
   *
   * The original spec called for running Tarjan on each node insertion. That is
   * O(V+E) *per insert*, so indexing a 20 000-file workspace becomes
   * O(V·(V+E)) — tens of seconds where the batched approach takes
   * milliseconds. Mutations mark the graph dirty instead, and components are
   * recomputed once, before results are published.
   */
  dirty: boolean
}

export interface Cycle {
  readonly id: string
  /** Sorted, so the same cycle always renders identically. */
  readonly members: readonly string[]
}

export function createGraph(): DependencyGraph {
  return { nodes: new Map(), dirty: false }
}

function ensureNode(graph: DependencyGraph, relativePath: string): GraphNode {
  const existing = graph.nodes.get(relativePath)
  if (existing !== undefined) return existing

  const created: GraphNode = {
    relativePath,
    imports: new Set(),
    importedBy: new Set(),
    mtimeMs: 0,
    componentId: relativePath
  }
  graph.nodes.set(relativePath, created)
  return created
}

export interface UpsertInput {
  readonly relativePath: string
  readonly imports: readonly string[]
  readonly mtimeMs?: number
}

/**
 * Inserts or replaces a node's outgoing edges.
 *
 * The subtle half is *removal*. When a file drops an import, the old target's
 * `importedBy` must lose this file — otherwise the reverse index accumulates
 * edges that no longer exist and the invalidation set widens with every edit
 * until each save rechecks the whole workspace. Diffing old against new is the
 * entire reason this is not a plain assignment.
 */
export function upsertNode(graph: DependencyGraph, input: UpsertInput): GraphNode {
  const node = ensureNode(graph, input.relativePath)
  const next = new Set(input.imports)

  for (const previous of node.imports) {
    if (next.has(previous)) continue
    graph.nodes.get(previous)?.importedBy.delete(input.relativePath)
  }

  for (const target of next) {
    if (node.imports.has(target)) continue
    // A node is created for an edge target even if it has not been walked yet,
    // so the reverse edge survives until the target is parsed for real.
    ensureNode(graph, target).importedBy.add(input.relativePath)
  }

  node.imports = next
  if (input.mtimeMs !== undefined) node.mtimeMs = input.mtimeMs
  graph.dirty = true
  return node
}

/**
 * Removes a node and every edge leaving it.
 *
 * Files that imported it keep their forward edge pointing at a path that no
 * longer exists. That is deliberate: the import statement is still in their
 * source, so the edge is real and the resulting "cannot find module" is a true
 * diagnostic. The node reappears the moment the file does.
 */
export function removeNode(graph: DependencyGraph, relativePath: string): boolean {
  const node = graph.nodes.get(relativePath)
  if (node === undefined) return false

  for (const target of node.imports) {
    graph.nodes.get(target)?.importedBy.delete(relativePath)
  }
  // Dependents keep their forward edge to this path on purpose — see above.

  graph.nodes.delete(relativePath)
  graph.dirty = true
  return true
}

/**
 * Every file that transitively imports `relativePath`, nearest first.
 *
 * Breadth-first, so the files most likely to be open — direct importers — are
 * checked before distant ones. A cycle terminates because `seen` is consulted
 * before enqueueing rather than after dequeueing.
 */
export function dependentsOf(graph: DependencyGraph, relativePath: string): string[] {
  const start = graph.nodes.get(relativePath)
  if (start === undefined) return []

  const seen = new Set<string>([relativePath])
  const out: string[] = []
  let frontier = [...start.importedBy]

  while (frontier.length > 0) {
    const next: string[] = []
    for (const path of frontier) {
      if (seen.has(path)) continue
      seen.add(path)
      out.push(path)

      const node = graph.nodes.get(path)
      if (node === undefined) continue
      for (const dependent of node.importedBy) {
        if (!seen.has(dependent)) next.push(dependent)
      }
    }
    frontier = next
  }

  return out
}

/**
 * The shortest import chain from one of `from` to `to`, trigger-first.
 *
 * This is the answer to "why was this file rechecked?". `dependentsOf` says
 * WHICH files are affected but returns a flat list, so the route is lost — and
 * the route is the explanation. `['src/lib.ts','src/util.ts','src/app.ts']` reads
 * as "lib is imported by util, which is imported by app".
 *
 * Multi-source, seeded from every path the pass reported changed, which gives the
 * chain from the NEAREST trigger for free. That is the honest answer when a watch
 * batch names several files: the shortest explanation, not an arbitrary one.
 *
 * Termination has the same guarantee `dependentsOf` documents — `seen` is
 * consulted before enqueueing rather than after dequeueing — so a cycle anywhere
 * on the route cannot loop.
 *
 * Returns `[to]` when `to` is itself one of the triggers (it was edited
 * directly), and `[]` when it is unreachable, which is a real answer rather than
 * an error: a file can be in the invalidation set of an earlier pass and have no
 * current route from this one's trigger.
 */
export function importPathTo(
  graph: DependencyGraph,
  from: readonly string[],
  to: string
): string[] {
  if (from.includes(to)) return [to]

  const seen = new Set<string>(from)
  // Child -> the node it was reached from, so the route can be walked back.
  const parent = new Map<string, string>()
  let frontier = from.filter((path) => graph.nodes.has(path))

  while (frontier.length > 0) {
    const next: string[] = []

    for (const path of frontier) {
      const node = graph.nodes.get(path)
      if (node === undefined) continue

      for (const dependent of node.importedBy) {
        if (seen.has(dependent)) continue
        seen.add(dependent)
        parent.set(dependent, path)

        if (dependent === to) {
          const chain = [to]
          let cursor = to
          for (;;) {
            const previous = parent.get(cursor)
            if (previous === undefined) break
            chain.push(previous)
            cursor = previous
          }
          return chain.reverse()
        }

        next.push(dependent)
      }
    }

    frontier = next
  }

  return []
}

/**
 * The set of files to re-check after `changed` were touched: the changed files
 * themselves plus everything that transitively depends on them.
 *
 * Deterministic regardless of the order `changed` arrives in. A watcher batch
 * has no meaningful order, and letting it leak through would make the order
 * diagnostics appear in vary run-to-run for identical edits.
 */
export function invalidationSet(
  graph: DependencyGraph,
  changed: readonly string[]
): string[] {
  const affected = new Set<string>()

  for (const path of [...changed].sort()) {
    affected.add(path)
    for (const dependent of dependentsOf(graph, path)) affected.add(dependent)
  }

  return [...affected]
}

/**
 * Tarjan's strongly-connected components — **iterative**, with an explicit
 * stack.
 *
 * The recursive formulation is shorter and is the wrong choice here: recursion
 * depth equals the longest import chain, and a deep chain in a real monorepo
 * overflows the JS stack. A `RangeError` while indexing would take the daemon
 * down on exactly the projects that need it most. There is a test that walks a
 * 50 000-node chain specifically to stop anyone reverting this to the shorter
 * recursive form.
 */
export function stronglyConnectedComponents(graph: DependencyGraph): string[][] {
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const components: string[][] = []
  let counter = 0

  interface Frame {
    readonly path: string
    readonly targets: string[]
    cursor: number
  }

  for (const root of graph.nodes.keys()) {
    if (index.has(root)) continue

    const frames: Frame[] = [
      { path: root, targets: [...(graph.nodes.get(root)?.imports ?? [])], cursor: 0 }
    ]
    index.set(root, counter)
    low.set(root, counter)
    counter++
    stack.push(root)
    onStack.add(root)

    while (frames.length > 0) {
      const frame = frames[frames.length - 1]
      if (frame === undefined) break

      if (frame.cursor < frame.targets.length) {
        const target = frame.targets[frame.cursor]
        frame.cursor++
        if (target === undefined) continue

        // An edge can point at a path with no node — a deleted file. It is part
        // of no component, so it is skipped rather than materialised.
        if (!graph.nodes.has(target)) continue

        if (!index.has(target)) {
          index.set(target, counter)
          low.set(target, counter)
          counter++
          stack.push(target)
          onStack.add(target)
          frames.push({
            path: target,
            targets: [...(graph.nodes.get(target)?.imports ?? [])],
            cursor: 0
          })
        } else if (onStack.has(target)) {
          low.set(frame.path, Math.min(low.get(frame.path) ?? 0, index.get(target) ?? 0))
        }
        continue
      }

      // Frame exhausted: fold its low-link into its parent, then close it off.
      frames.pop()
      const parent = frames[frames.length - 1]
      if (parent !== undefined) {
        low.set(parent.path, Math.min(low.get(parent.path) ?? 0, low.get(frame.path) ?? 0))
      }

      if (low.get(frame.path) === index.get(frame.path)) {
        const component: string[] = []
        for (;;) {
          const member = stack.pop()
          if (member === undefined) break
          onStack.delete(member)
          component.push(member)
          if (member === frame.path) break
        }
        components.push(component)
      }
    }
  }

  return components
}

/**
 * Stamps every node with its component id and returns the real cycles.
 *
 * A cycle is a component of two or more members, or a lone node that imports
 * itself. `componentId` is the lexicographically smallest member, so the id is
 * stable across runs and independent of insertion order — an id that shifted
 * between runs would make cached results unusable later.
 *
 * What the component id actually buys, stated plainly: `ts.LanguageService`
 * already handles import cycles, so there is no "compilation unit" here to
 * collapse. It makes invalidating a cycle one step instead of a re-walk.
 */
export function assignComponents(graph: DependencyGraph): Cycle[] {
  const components = stronglyConnectedComponents(graph)
  const cycles: Cycle[] = []

  for (const component of components) {
    const members = [...component].sort()
    const id = members[0] ?? ''

    for (const member of members) {
      const node = graph.nodes.get(member)
      if (node !== undefined) node.componentId = id
    }

    if (members.length > 1) {
      cycles.push({ id, members })
      continue
    }

    // A single-member component is a cycle only if it imports itself.
    const only = members[0]
    if (only !== undefined && graph.nodes.get(only)?.imports.has(only) === true) {
      cycles.push({ id, members })
    }
  }

  graph.dirty = false
  return cycles.sort((a, b) => a.id.localeCompare(b.id))
}

/** Total forward edges — reported in the graph summary. */
export function edgeCount(graph: DependencyGraph): number {
  let total = 0
  for (const node of graph.nodes.values()) total += node.imports.size
  return total
}

/** The cycle containing `relativePath`, or null. */
export function cycleFor(cycles: readonly Cycle[], relativePath: string): Cycle | null {
  return cycles.find((cycle) => cycle.members.includes(relativePath)) ?? null
}
