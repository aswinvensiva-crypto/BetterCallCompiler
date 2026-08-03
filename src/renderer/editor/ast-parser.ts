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
 */

/**
 * `@babel/traverse` is CommonJS with a `default` export. Under Vite's ESM
 * interop the namespace object itself is sometimes returned instead of that
 * default, and calling it throws "traverse is not a function". Resolving both
 * shapes is the standard guard and costs nothing.
 */
const traverse = (
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
function nodeId(counter: number, line: number): string {
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

interface Builder {
  readonly lines: string[]
  counter: number
  nodes: number
}

function add(builder: Builder, statement: string): void {
  builder.lines.push(`  ${statement}`)
}

/**
 * Emits one node per interesting construct.
 *
 * Deliberately a topography rather than a faithful control-flow graph: the goal
 * is to see the shape of a function at a glance — where it branches, where it
 * loops, where it leaves — not to produce something a compiler would accept.
 */
function walk(ast: t.File, startLine: number, builder: Builder): void {
  const absolute = (node: t.Node): number => (node.loc?.start.line ?? 1) + startLine - 1

  const emit = (node: t.Node, shape: (id: string) => string): string => {
    const id = nodeId(builder.counter++, absolute(node))
    add(builder, shape(id))
    builder.nodes++
    return id
  }

  traverse(ast, {
    Function(path: NodePath<t.Function>) {
      const node = path.node
      let name = 'anonymous'
      if ('id' in node && node.id !== null && node.id !== undefined) {
        name = node.id.name
      } else if (path.parent.type === 'VariableDeclarator' && path.parent.id.type === 'Identifier') {
        name = path.parent.id.name
      } else if (path.parent.type === 'ObjectProperty' && path.parent.key.type === 'Identifier') {
        name = path.parent.key.name
      }
      emit(node, (id) => `${id}[["${label(`${name}()`)}"]]`)
    },

    IfStatement(path: NodePath<t.IfStatement>) {
      const test = sourceOf(path.get('test'))
      emit(path.node, (id) => `${id}{"${label(`If (${test})`)}"}`)
    },

    ForStatement(path: NodePath<t.ForStatement>) {
      emit(path.node, (id) => `${id}["${label('For loop')}"]`)
    },
    ForOfStatement(path: NodePath<t.ForOfStatement>) {
      const right = sourceOf(path.get('right'))
      emit(path.node, (id) => `${id}["${label(`For of ${right}`)}"]`)
    },
    ForInStatement(path: NodePath<t.ForInStatement>) {
      emit(path.node, (id) => `${id}["${label('For in')}"]`)
    },
    WhileStatement(path: NodePath<t.WhileStatement>) {
      const test = sourceOf(path.get('test'))
      emit(path.node, (id) => `${id}["${label(`While (${test})`)}"]`)
    },

    TryStatement(path: NodePath<t.TryStatement>) {
      emit(path.node, (id) => `${id}["${label('Try')}"]`)
    },

    CallExpression(path: NodePath<t.CallExpression>) {
      const callee = path.node.callee
      let name: string | null = null
      if (callee.type === 'Identifier') name = callee.name
      else if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
        name = callee.property.name
      }
      if (name === null) return
      emit(path.node, (id) => `${id}["${label(`Call: ${name}()`)}"]`)
    },

    ReturnStatement(path: NodePath<t.ReturnStatement>) {
      emit(path.node, (id) => `${id}(["${label('Return')}"])`)
    },
    ThrowStatement(path: NodePath<t.ThrowStatement>) {
      emit(path.node, (id) => `${id}(["${label('Throw')}"])`)
    }
  })
}

/** Best-effort source text for a label; falls back to the node type. */
function sourceOf(path: NodePath<t.Node | null | undefined>): string {
  const node = path.node
  if (node === null || node === undefined) return '…'
  if (node.type === 'Identifier') return node.name
  if (node.type === 'BinaryExpression' || node.type === 'LogicalExpression') {
    return `${sourceOf(path.get('left') as NodePath<t.Node>)} ${node.operator} ${sourceOf(
      path.get('right') as NodePath<t.Node>
    )}`
  }
  if (node.type === 'MemberExpression' && node.property.type === 'Identifier') {
    return `${sourceOf(path.get('object') as NodePath<t.Node>)}.${node.property.name}`
  }
  if (node.type === 'CallExpression') return `${sourceOf(path.get('callee') as NodePath<t.Node>)}()`
  if (node.type === 'StringLiteral') return `'${node.value}'`
  if (node.type === 'NumericLiteral') return String(node.value)
  if (node.type === 'UnaryExpression') {
    return `${node.operator}${sourceOf(path.get('argument') as NodePath<t.Node>)}`
  }
  return node.type.replace(/Expression$/, '')
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
  const lines = code
    .split('\n')
    .map((line, index) => ({ text: line.trim(), line: startLine + index }))
    .filter((entry) => entry.text !== '' && !/^(\/\/|#|\*|\/\*)/.test(entry.text))
    .slice(0, 40)

  const builder: Builder = { lines: ['graph TD'], counter: 0, nodes: 0 }

  if (lines.length === 0) {
    add(builder, 'empty["Nothing to diagram"]')
    return { definition: builder.lines.join('\n'), source: 'fallback', error, nodeCount: 0 }
  }

  const ids = lines.map((entry) => {
    const id = nodeId(builder.counter++, entry.line)
    add(builder, `${id}["${label(entry.text)}"]`)
    builder.nodes++
    return id
  })
  for (let i = 0; i < ids.length - 1; i++) {
    add(builder, `${ids[i]} --> ${ids[i + 1]}`)
  }

  return {
    definition: builder.lines.join('\n'),
    source: 'fallback',
    error,
    nodeCount: builder.nodes
  }
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
    ast = parse(code, PARSER_OPTIONS)
  } catch (error) {
    return fallbackDiagram(
      code,
      startLine,
      error instanceof Error ? error.message : 'could not parse the selection'
    )
  }

  const builder: Builder = { lines: ['graph TD'], counter: 0, nodes: 0 }

  try {
    walk(ast, startLine, builder)
  } catch (error) {
    return fallbackDiagram(
      code,
      startLine,
      error instanceof Error ? error.message : 'could not walk the syntax tree'
    )
  }

  // Parsed fine but contained nothing worth drawing (a type alias, a constant).
  if (builder.nodes === 0) {
    return fallbackDiagram(code, startLine, '')
  }

  // Chain the emitted nodes in source order. A real CFG would branch here; the
  // ordering is honest about being a reading sequence, not an execution path.
  const emitted = builder.lines
    .slice(1)
    .map((line) => /^ {2}(n\d+_L\d+)/.exec(line)?.[1])
    .filter((id): id is string => id !== undefined)

  for (let i = 0; i < emitted.length - 1; i++) {
    add(builder, `${emitted[i]} --> ${emitted[i + 1]}`)
  }

  return {
    definition: builder.lines.join('\n'),
    source: 'ast',
    error: null,
    nodeCount: builder.nodes
  }
}
