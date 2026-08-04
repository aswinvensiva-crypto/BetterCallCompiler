import { parse, type ParserOptions } from '@babel/parser'
import traverseModule, { type NodePath } from '@babel/traverse'
import type * as t from '@babel/types'

/**
 * Turns a selection of source into a Mermaid `graph TD` flowchart.
 *
 * Entirely deterministic and offline: Babel parses, we walk, a string comes
 * out. No model, no network, nothing cached. Every node id embeds the source
 * line it came from (`n3_L42`) so the rendered diagram can be clicked back to
 * the editor — that mapping is the whole reason for the id scheme.
 *
 * Language coverage is JS/TS/JSX/TSX, which is what `@babel/parser` handles.
 * Python and C/C++ would each need a `web-tree-sitter` grammar; that is real
 * added scope and is deliberately not attempted here rather than faked.
 *
 * The walk no longer writes Mermaid syntax directly. It produces a list of
 * `TopographyNode` records — shape, line, unescaped text — which is then
 * projected to a definition string. That split exists because `code-graph.ts`
 * needs the same parse, the same naming rules and the same expression
 * descriptions to build a real control-flow graph, and duplicating them would
 * guarantee the two views eventually disagree about what a node is called. The
 * primitives that both share are exported below; they are internal to the
 * editor package, not public API.
 */

/**
 * `@babel/traverse` is CommonJS with a `default` export. Under Vite's ESM
 * interop the namespace object itself is sometimes returned instead of that
 * default, and calling it throws "traverse is not a function". Resolving both
 * shapes is the standard guard and costs nothing.
 *
 * Exported so the guard exists exactly once. Every other module in the editor
 * package traverses through this binding, never through the raw import.
 */
export const babelTraverse = (
  (traverseModule as unknown as { default?: typeof traverseModule }).default ?? traverseModule
) as typeof traverseModule

export type DiagramSource = 'ast' | 'fallback'

export interface Diagram {
  /** A complete Mermaid definition, ready for `mermaid.render`. */
  readonly definition: string
  readonly source: DiagramSource
  /** Populated when parsing failed and the fallback was used. */
  readonly error: string | null
  readonly nodeCount: number
}

const PARSER_OPTIONS: ParserOptions = {
  sourceType: 'unambiguous',
  errorRecovery: true,
  allowReturnOutsideFunction: true,
  allowAwaitOutsideFunction: true,
  allowSuperOutsideMethod: true,
  plugins: ['typescript', 'jsx', 'decorators-legacy', 'classProperties', 'topLevelAwait']
}

/**
 * Parses JS/TS/JSX/TSX with recovery on.
 *
 * Throws on an unrecoverable parse. Every caller is expected to catch and
 * degrade to a fallback rather than let an exception reach the panel — this
 * runs on a keystroke debounce, so most inputs are transiently invalid.
 */
export function parseSource(code: string): t.File {
  return parse(code, PARSER_OPTIONS)
}

/**
 * Escapes a label for Mermaid.
 *
 * Comparison operators are left as raw characters. Two wrong answers were tried
 * first and both are worth recording:
 *
 *   - Stripping them turns `If (a > 1)` into `If (a  1)`, which is not cosmetic:
 *     it draws a condition the code does not contain, and looks correct.
 *   - Escaping them as numeric entities (`#62;`) fails under
 *     `htmlLabels: false`, where Mermaid renders into SVG <text> and emits the
 *     entity literally — the user sees `If (value &#62; 10)` on screen.
 *
 * Inside a quoted label the parser treats the contents as a string, so `<` and
 * `>` pass through safely. Only the delimiters themselves have to go.
 */
function label(text: string, max = 44): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const clipped = flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
  return clipped
    .replace(/"/g, "'")
    .replace(/[{}]/g, '')
    .replace(/[[\]]/g, '')
    .replace(/\|/g, '/')
}

/** `n<counter>_L<line>` — the line is parsed back out on click. */
export function makeNodeId(counter: number, line: number): string {
  return `n${counter}_L${line}`
}

/**
 * Recovers the source line from a node id.
 *
 * Deliberately NOT anchored to the end of the string. Mermaid does not render
 * the ids it is given verbatim — it rewrites `n0_L1` into
 * `flowchart-n0_L1-0`, adding both a prefix and an index suffix. An anchored
 * `/_L(\d+)$/` therefore matches the ids we generate and none of the ids that
 * actually exist in the DOM, so click-to-source silently attached to nothing.
 */
export function lineFromNodeId(id: string): number | null {
  const match = /_L(\d+)(?!\d)/.exec(id)
  if (match === null) return null
  const line = Number.parseInt(match[1] ?? '', 10)
  return Number.isNaN(line) ? null : line
}

/**
 * Names a function for display.
 *
 * Anonymous functions are extremely common in this codebase's own idiom
 * (`const handler = () => …`), and a diagram full of boxes labelled
 * `anonymous()` is worthless, so the two containers that actually carry a name
 * are consulted. Class and object *methods* are deliberately not handled here:
 * changing this would change `generateDiagram`'s output, which the Visualizer
 * and its e2e assertions still depend on byte-for-byte. `code-graph.ts` names
 * members itself.
 */
export function functionName(node: t.Function, parent: t.Node | null): string {
  if ('id' in node && node.id !== null && node.id !== undefined) return node.id.name
  if (parent !== null) {
    if (parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier') return parent.id.name
    if (parent.type === 'ObjectProperty' && parent.key.type === 'Identifier') return parent.key.name
  }
  return 'anonymous'
}

/**
 * The name a call should be labelled with, or null when there is not one.
 *
 * A computed callee (`handlers[kind]()`) returns null rather than a made-up
 * name — the legacy diagram then omits the node entirely, which is honest.
 */
export function calleeName(callee: t.Node): string | null {
  if (callee.type === 'Identifier') return callee.name
  if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
    return callee.property.name
  }
  return null
}

/**
 * Best-effort source text for a label; falls back to the node type.
 *
 * Node-based rather than path-based so it can be used from a hand-rolled walk
 * as well as from a Babel visitor. The cases covered are exactly the ones the
 * legacy diagram already covered — adding more would silently change labels the
 * Visualizer and its e2e test assert on.
 */
export function describeExpression(node: t.Node | null | undefined): string {
  if (node === null || node === undefined) return '…'
  if (node.type === 'Identifier') return node.name
  if (node.type === 'BinaryExpression' || node.type === 'LogicalExpression') {
    return `${describeExpression(node.left)} ${node.operator} ${describeExpression(node.right)}`
  }
  if (node.type === 'MemberExpression' && node.property.type === 'Identifier') {
    return `${describeExpression(node.object)}.${node.property.name}`
  }
  if (node.type === 'CallExpression') return `${describeExpression(node.callee)}()`
  if (node.type === 'StringLiteral') return `'${node.value}'`
  if (node.type === 'NumericLiteral') return String(node.value)
  if (node.type === 'UnaryExpression') {
    return `${node.operator}${describeExpression(node.argument)}`
  }
  return node.type.replace(/Expression$/, '')
}

/* --------------------------- topography walk ----------------------------- */

/** Mermaid's four box shapes, named by what they mean rather than by syntax. */
type TopographyShape = 'process' | 'decision' | 'subroutine' | 'terminal'

interface TopographyNode {
  readonly shape: TopographyShape
  /** Absolute source line, already offset by the selection start. */
  readonly line: number
  /** Unescaped label text; `label()` is applied at projection time. */
  readonly text: string
}

const SHAPES: Readonly<Record<TopographyShape, (id: string, text: string) => string>> = {
  process: (id, text) => `${id}["${text}"]`,
  decision: (id, text) => `${id}{"${text}"}`,
  subroutine: (id, text) => `${id}[["${text}"]]`,
  terminal: (id, text) => `${id}(["${text}"])`
}

/**
 * Emits one record per interesting construct, in Babel's traversal order.
 *
 * Deliberately a topography rather than a faithful control-flow graph: the goal
 * is to see the shape of a function at a glance — where it branches, where it
 * loops, where it leaves — not to produce something a compiler would accept.
 * `code-graph.ts` is where the branch-accurate CFG lives; this walk stays as it
 * was because the Visualizer still renders its output.
 */
function walk(ast: t.File, startLine: number): TopographyNode[] {
  const found: TopographyNode[] = []
  const absolute = (node: t.Node): number => (node.loc?.start.line ?? 1) + startLine - 1
  const emit = (node: t.Node, shape: TopographyShape, text: string): void => {
    found.push({ shape, line: absolute(node), text })
  }

  babelTraverse(ast, {
    Function(path: NodePath<t.Function>) {
      emit(path.node, 'subroutine', `${functionName(path.node, path.parent)}()`)
    },

    IfStatement(path: NodePath<t.IfStatement>) {
      emit(path.node, 'decision', `If (${describeExpression(path.node.test)})`)
    },

    ForStatement(path: NodePath<t.ForStatement>) {
      emit(path.node, 'process', 'For loop')
    },
    ForOfStatement(path: NodePath<t.ForOfStatement>) {
      emit(path.node, 'process', `For of ${describeExpression(path.node.right)}`)
    },
    ForInStatement(path: NodePath<t.ForInStatement>) {
      emit(path.node, 'process', 'For in')
    },
    WhileStatement(path: NodePath<t.WhileStatement>) {
      emit(path.node, 'process', `While (${describeExpression(path.node.test)})`)
    },

    TryStatement(path: NodePath<t.TryStatement>) {
      emit(path.node, 'process', 'Try')
    },

    CallExpression(path: NodePath<t.CallExpression>) {
      const name = calleeName(path.node.callee)
      if (name === null) return
      emit(path.node, 'process', `Call: ${name}()`)
    },

    ReturnStatement(path: NodePath<t.ReturnStatement>) {
      emit(path.node, 'terminal', 'Return')
    },
    ThrowStatement(path: NodePath<t.ThrowStatement>) {
      emit(path.node, 'terminal', 'Throw')
    }
  })

  return found
}

/**
 * Projects the walk's records to a Mermaid definition.
 *
 * The nodes are chained in source order. A real CFG would branch here; this
 * ordering is honest about being a reading sequence, not an execution path —
 * see `buildSelectionGraph` for the version that does branch.
 */
function project(found: readonly TopographyNode[]): string {
  const statements: string[] = []
  const ids: string[] = []

  for (let i = 0; i < found.length; i++) {
    const node = found[i]
    if (node === undefined) continue
    const id = makeNodeId(i, node.line)
    ids.push(id)
    statements.push(`  ${SHAPES[node.shape](id, label(node.text))}`)
  }

  for (let i = 0; i < ids.length - 1; i++) {
    const from = ids[i]
    const to = ids[i + 1]
    if (from === undefined || to === undefined) continue
    statements.push(`  ${from} --> ${to}`)
  }

  return ['graph TD', ...statements].join('\n')
}

/**
 * A block-per-line diagram, used when the selection will not parse.
 *
 * Showing *something* is the point. A blank panel or a red error reads as the
 * feature being broken, when in reality the user is mid-edit and the code is
 * transiently invalid — which is most keystrokes. This matches the codebase's
 * existing habit of degrading visibly rather than dead-ending.
 */
function fallbackDiagram(code: string, startLine: number, error: string): Diagram {
  const lines = sourceLines(code, startLine)

  if (lines.length === 0) {
    return {
      definition: 'graph TD\n  empty["Nothing to diagram"]',
      source: 'fallback',
      error,
      nodeCount: 0
    }
  }

  const found: TopographyNode[] = lines.map((entry) => ({
    shape: 'process',
    line: entry.line,
    text: entry.text
  }))

  return {
    definition: project(found),
    source: 'fallback',
    error,
    nodeCount: found.length
  }
}

/**
 * Non-blank, non-comment lines with their absolute numbering, capped.
 *
 * The cap is not cosmetic: without it a 2000-line paste becomes 2000 boxes and
 * the renderer stops responding. Shared with `code-graph.ts` so both fallbacks
 * truncate at the same place and a user switching views sees the same lines.
 */
export const FALLBACK_LINE_LIMIT = 40

export function sourceLines(
  code: string,
  startLine: number
): { readonly text: string; readonly line: number }[] {
  return code
    .split('\n')
    .map((line, index) => ({ text: line.trim(), line: startLine + index }))
    .filter((entry) => entry.text !== '' && !/^(\/\/|#|\*|\/\*)/.test(entry.text))
    .slice(0, FALLBACK_LINE_LIMIT)
}

/**
 * Builds a diagram for `code`, whose first line is `startLine` in the file.
 *
 * Never throws. A parse failure produces the sequential fallback rather than an
 * exception, because this runs on every debounced cursor move and a throw would
 * take the panel down mid-typing.
 */
export function generateDiagram(code: string, startLine = 1): Diagram {
  if (code.trim() === '') {
    return {
      definition: 'graph TD\n  empty["Nothing selected"]',
      source: 'fallback',
      error: null,
      nodeCount: 0
    }
  }

  let ast: t.File
  try {
    ast = parseSource(code)
  } catch (error) {
    return fallbackDiagram(
      code,
      startLine,
      error instanceof Error ? error.message : 'could not parse the selection'
    )
  }

  let found: TopographyNode[]
  try {
    found = walk(ast, startLine)
  } catch (error) {
    return fallbackDiagram(
      code,
      startLine,
      error instanceof Error ? error.message : 'could not walk the syntax tree'
    )
  }

  // Parsed fine but contained nothing worth drawing (a type alias, a constant).
  if (found.length === 0) {
    return fallbackDiagram(code, startLine, '')
  }

  return {
    definition: project(found),
    source: 'ast',
    error: null,
    nodeCount: found.length
  }
}
