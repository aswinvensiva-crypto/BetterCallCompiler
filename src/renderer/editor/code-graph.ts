import type { NodePath } from '@babel/traverse'
import type * as t from '@babel/types'
import type {
  CodeGraph,
  CodeGraphEdge,
  CodeGraphNode,
  GraphEdgeKind,
  GraphMode,
  GraphNodeCategory,
  GraphNodeKind,
  GraphNodeMetrics,
  GraphParam,
  SourceLocation
} from '../../shared/code-graph'
import {
  babelTraverse,
  describeExpression,
  functionName,
  makeNodeId,
  parseSource,
  sourceLines
} from './ast-parser'

/**
 * Builds the two graphs behind the Visualizer: a branch-accurate control-flow
 * graph of a selection, and a structure-plus-call graph of a whole file.
 *
 * This replaces the "reading sequence" the legacy diagram draws, where every
 * emitted node was chained to the next one in traversal order with a single
 * edge kind. That ordering was honest about being a reading sequence but it
 * drew flow the code does not have: a `return` had an outgoing edge, an `if`
 * had no false branch, and a `switch` looked like a straight line. Everything
 * here exists to stop doing that.
 *
 * Still entirely offline and deterministic: Babel parses, we walk, a data
 * structure comes out. No model, no network, no filesystem — cross-*file* call
 * graphs are explicitly out of scope, because resolving an import means reading
 * another file and the renderer has no business doing that.
 *
 * Two walks, not one, and the reason is worth stating. `generateDiagram` in
 * `ast-parser.ts` uses a flat `@babel/traverse` visitor because a flat list is
 * exactly what it projects. A control-flow graph is a *recursive descent*: each
 * statement has to hand its dangling exits to whatever follows it, and a
 * visitor that is called back in pre-order cannot express that. The file graph
 * does use `@babel/traverse`, twice, because it needs Babel's scope bindings.
 * What is shared is everything that decides what a thing is *called* —
 * `parseSource`, `functionName`, `describeExpression`, the id scheme — so the
 * two views can never disagree about the name of the same construct.
 *
 * Both entry points are pure and NEVER THROW. They run on a debounced cursor
 * move; an exception takes the panel down while the user is still typing.
 */

/* ---------------------------- category rules ----------------------------- */

/**
 * CATEGORY PRECEDENCE, first match wins. This is the only colour input the UI
 * gets, so it has to be total and deterministic — an exported async function
 * must land in exactly one bucket, forever.
 *
 *   1. terminal  — `return` / `throw` nodes.
 *   2. control   — if / switch / case / loop / try / catch / finally nodes.
 *   3. external  — a call that could not be resolved inside this file.
 *   4. exported  — the declaration leaves the module (named or default).
 *   5. async     — `async` or generator, and not exported.
 *   6. internal  — everything else.
 *
 * Kind wins over declaration status because a `return` inside an exported
 * function is still a return; colouring it "exported" would say something false
 * about the node in front of you.
 *
 * Export status wins over asyncness because at file scale the question the
 * reader is asking is "what is the surface of this module" far more often than
 * "what is awaited". Nothing is lost: `isAsync` and `isGenerator` are on every
 * node, so a UI that wants to badge asyncness separately can.
 */
type Visibility = NonNullable<CodeGraphNode['visibility']>

function declarationCategory(
  visibility: Visibility | null,
  isAsync: boolean,
  isGenerator: boolean
): GraphNodeCategory {
  if (visibility === 'exported' || visibility === 'default-exported') return 'exported'
  if (isAsync || isGenerator) return 'async'
  return 'internal'
}

/* ------------------------------- drafting -------------------------------- */

/**
 * The mutable form of a node. Enrichment happens in several steps (name, then
 * params, then metrics, then callers as they are discovered), and threading an
 * immutable record through all of them would be ceremony with no payoff — the
 * draft never escapes this module.
 */
interface DraftNode {
  readonly id: string
  readonly kind: GraphNodeKind
  label: string
  category: GraphNodeCategory
  readonly location: SourceLocation
  parentId: string | null
  signature: string | null
  params: readonly GraphParam[]
  returnType: string | null
  visibility: Visibility | null
  isAsync: boolean
  isGenerator: boolean
  jsDoc: string | null
  metrics: GraphNodeMetrics | null
  readonly callers: string[]
  readonly callees: string[]
}

interface Builder {
  readonly nodes: DraftNode[]
  readonly edges: CodeGraphEdge[]
  /** First line of `code` within the file; every location is offset by it. */
  readonly startLine: number
  counter: number
}

function createBuilder(startLine: number): Builder {
  return { nodes: [], edges: [], startLine, counter: 0 }
}

/**
 * Labels are plain text here on purpose.
 *
 * Escaping is the renderer's problem and depends on what draws the graph —
 * Mermaid's quoting rules are not the DOM's. Doing it at this layer once meant
 * the data carried Mermaid syntax into a view that had no idea what to do
 * with it.
 */
const MAX_LABEL = 72

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_LABEL ? `${flat.slice(0, MAX_LABEL - 1)}…` : flat
}

/**
 * Babel columns are 0-based; every position elsewhere in this app is 1-based.
 * The shift happens here so nothing downstream has to remember it.
 */
function locationOf(node: t.Node, startLine: number): SourceLocation {
  const loc = node.loc
  if (loc === null || loc === undefined) {
    return { startLine, startColumn: 1, endLine: startLine, endColumn: 1 }
  }
  return {
    startLine: loc.start.line + startLine - 1,
    startColumn: loc.start.column + 1,
    endLine: loc.end.line + startLine - 1,
    endColumn: loc.end.column + 1
  }
}

function addNode(
  builder: Builder,
  kind: GraphNodeKind,
  label: string,
  category: GraphNodeCategory,
  node: t.Node
): DraftNode {
  const location = locationOf(node, builder.startLine)
  const draft: DraftNode = {
    id: makeNodeId(builder.counter++, location.startLine),
    kind,
    label: clip(label),
    category,
    location,
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
  builder.nodes.push(draft)
  return draft
}

function addEdge(
  builder: Builder,
  source: string,
  target: string,
  kind: GraphEdgeKind,
  label: string | null
): void {
  builder.edges.push({ id: `e${builder.edges.length}_${source}`, source, target, kind, label })
}

function toGraphNode(draft: DraftNode): CodeGraphNode {
  return {
    id: draft.id,
    kind: draft.kind,
    label: draft.label,
    category: draft.category,
    location: draft.location,
    parentId: draft.parentId,
    signature: draft.signature,
    params: [...draft.params],
    returnType: draft.returnType,
    visibility: draft.visibility,
    isAsync: draft.isAsync,
    isGenerator: draft.isGenerator,
    jsDoc: draft.jsDoc,
    metrics: draft.metrics,
    callers: [...draft.callers],
    callees: [...draft.callees]
  }
}

/**
 * Freezes the draft into the exported shape and works out the layout roots.
 *
 * `loop-back` edges are excluded from the incoming count deliberately: a
 * `while` header always has one pointing at it, so counting them would leave
 * every looping function with no root at all and nothing for a layout pass to
 * start from.
 */
function finish(
  builder: Builder,
  mode: GraphMode,
  source: 'ast' | 'fallback',
  error: string | null
): CodeGraph {
  const reachable = new Set<string>()
  for (const edge of builder.edges) {
    if (edge.kind !== 'loop-back') reachable.add(edge.target)
  }

  return {
    mode,
    nodes: builder.nodes.map(toGraphNode),
    edges: [...builder.edges],
    source,
    error,
    rootIds: builder.nodes.filter((node) => !reachable.has(node.id)).map((node) => node.id)
  }
}

/* --------------------------- generic AST walk ---------------------------- */

/**
 * A hand-rolled child iterator.
 *
 * `@babel/traverse` needs a `NodePath` and a full scope crawl, neither of which
 * exists inside our own recursive descent, and `@babel/types` ships a `traverse`
 * of its own but is only a *transitive* dependency here (package.json declares
 * the parser and traverse). Reaching through to an undeclared package would
 * make a private hoisting decision load-bearing, so twenty lines of
 * `Object.keys` it is.
 */
const NON_CHILD_KEYS: ReadonlySet<string> = new Set([
  'loc',
  'start',
  'end',
  'range',
  'extra',
  'leadingComments',
  'trailingComments',
  'innerComments'
])

function isNode(value: unknown): value is t.Node {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  )
}

function forEachChild(node: t.Node, visit: (child: t.Node) => void): void {
  const record = node as unknown as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (NON_CHILD_KEYS.has(key)) continue
    const value = record[key]
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) visit(item)
    } else if (isNode(value)) {
      visit(value)
    }
  }
}

function isFunctionNode(node: t.Node): node is t.Function {
  return (
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'ObjectMethod' ||
    node.type === 'ClassMethod' ||
    node.type === 'ClassPrivateMethod'
  )
}

type AnyCall = t.CallExpression | t.OptionalCallExpression

/**
 * Calls reachable from `node` without entering a nested function body.
 *
 * A callback's calls belong to the callback, not to the statement that happens
 * to pass it — attributing them upward is how call graphs end up claiming that
 * every function calls everything.
 */
function collectCalls(node: t.Node, out: AnyCall[]): void {
  if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') out.push(node)
  forEachChild(node, (child) => {
    if (isFunctionNode(child)) return
    collectCalls(child, out)
  })
}

/* ---------------------------- node enrichment ---------------------------- */

/**
 * Renders a TypeScript type annotation back to source-ish text.
 *
 * Hand-written because `@babel/generator` is not a dependency and adding one
 * for this would be absurd. Anything this printer does not recognise returns
 * null rather than a stab at the node type: there is no type checker anywhere
 * in this app, so a fabricated type would be a guess that reads as a fact.
 * Object and function types collapse to `{…}` / `(…) => …`, which is a summary
 * rather than a guess — the full text would blow past the label budget anyway.
 */
function printType(node: t.Node | null | undefined): string | null {
  if (node === null || node === undefined) return null
  switch (node.type) {
    case 'TSTypeAnnotation':
      return printType(node.typeAnnotation)
    case 'TSAnyKeyword':
      return 'any'
    case 'TSBigIntKeyword':
      return 'bigint'
    case 'TSBooleanKeyword':
      return 'boolean'
    case 'TSNeverKeyword':
      return 'never'
    case 'TSNullKeyword':
      return 'null'
    case 'TSNumberKeyword':
      return 'number'
    case 'TSObjectKeyword':
      return 'object'
    case 'TSStringKeyword':
      return 'string'
    case 'TSSymbolKeyword':
      return 'symbol'
    case 'TSUndefinedKeyword':
      return 'undefined'
    case 'TSUnknownKeyword':
      return 'unknown'
    case 'TSVoidKeyword':
      return 'void'
    case 'TSThisType':
      return 'this'
    case 'TSArrayType': {
      const inner = printType(node.elementType)
      return inner === null ? null : `${inner}[]`
    }
    case 'TSParenthesizedType': {
      const inner = printType(node.typeAnnotation)
      return inner === null ? null : `(${inner})`
    }
    case 'TSTypeOperator': {
      const inner = printType(node.typeAnnotation)
      return inner === null ? null : `${node.operator} ${inner}`
    }
    case 'TSUnionType':
      return joinTypes(node.types, ' | ')
    case 'TSIntersectionType':
      return joinTypes(node.types, ' & ')
    case 'TSTupleType':
      return null
    case 'TSLiteralType':
      return printTypeLiteral(node.literal)
    case 'TSTypeReference': {
      const name = printEntityName(node.typeName)
      if (name === null) return null
      const args = node.typeParameters
      if (args === null || args === undefined) return name
      const rendered = joinTypes(args.params, ', ')
      return rendered === null ? name : `${name}<${rendered}>`
    }
    case 'TSTypeLiteral':
      return '{…}'
    case 'TSFunctionType':
      return '(…) => …'
    default:
      return null
  }
}

/** Null if any member is unprintable — half a union is worse than no union. */
function joinTypes(types: readonly t.Node[], separator: string): string | null {
  const parts: string[] = []
  for (const type of types) {
    const printed = printType(type)
    if (printed === null) return null
    parts.push(printed)
  }
  return parts.length === 0 ? null : parts.join(separator)
}

function printTypeLiteral(literal: t.Node): string | null {
  if (literal.type === 'StringLiteral') return `'${literal.value}'`
  if (literal.type === 'NumericLiteral') return String(literal.value)
  if (literal.type === 'BooleanLiteral') return String(literal.value)
  return null
}

function printEntityName(name: t.Node): string | null {
  if (name.type === 'Identifier') return name.name
  if (name.type === 'TSQualifiedName') {
    const left = printEntityName(name.left)
    return left === null ? null : `${left}.${name.right.name}`
  }
  return null
}

/**
 * Destructured parameters are summarised, not expanded. `{ a, b, c }` in a
 * signature is noise once there are three of them, and the location on the node
 * already points at the real thing.
 */
function paramName(node: t.Node): string {
  switch (node.type) {
    case 'Identifier':
      return node.name
    case 'AssignmentPattern':
      return paramName(node.left)
    case 'RestElement':
      return `...${paramName(node.argument)}`
    case 'ObjectPattern':
      return '{…}'
    case 'ArrayPattern':
      return '[…]'
    case 'TSParameterProperty':
      return paramName(node.parameter)
    default:
      return '…'
  }
}

function paramTypeAnnotation(node: t.Node): t.Node | null {
  switch (node.type) {
    case 'Identifier':
    case 'ObjectPattern':
    case 'ArrayPattern':
    case 'RestElement':
      return node.typeAnnotation ?? null
    case 'AssignmentPattern':
      return paramTypeAnnotation(node.left)
    case 'TSParameterProperty':
      return paramTypeAnnotation(node.parameter)
    default:
      return null
  }
}

function paramsOf(params: readonly t.Node[]): GraphParam[] {
  return params.map((param) => ({
    name: paramName(param),
    type: printType(paramTypeAnnotation(param))
  }))
}

function signatureOf(
  name: string,
  params: readonly GraphParam[],
  returnType: string | null
): string {
  const rendered = params
    .map((param) => (param.type === null ? param.name : `${param.name}: ${param.type}`))
    .join(', ')
  return returnType === null ? `${name}(${rendered})` : `${name}(${rendered}): ${returnType}`
}

/**
 * The leading JSDoc/TSDoc block, stripped of its furniture.
 *
 * Several hosts are tried in order because Babel attaches the comment to the
 * outermost statement: for `export function f()` it lands on the
 * `ExportNamedDeclaration`, not on the function. Checking only the function
 * meant every exported symbol — which is to say, every symbol a reader cares
 * about — came back with no documentation.
 */
function jsDocOf(hosts: readonly (t.Node | null | undefined)[]): string | null {
  for (const host of hosts) {
    if (host === null || host === undefined) continue
    const comments = host.leadingComments
    if (comments === null || comments === undefined) continue

    for (let i = comments.length - 1; i >= 0; i--) {
      const comment = comments[i]
      if (comment === undefined) continue
      if (comment.type !== 'CommentBlock') continue
      // `/** … */` only. A plain `/* … */` is a note to the next reader of that
      // line, not documentation of the symbol, and hoisting it into the panel
      // as a description misrepresents it.
      if (!comment.value.startsWith('*')) continue

      const cleaned = comment.value
        .slice(1)
        .split('\n')
        .map((line) => line.replace(/^\s*\*\s?/, '').trimEnd())
        .join('\n')
        .trim()
      if (cleaned !== '') return cleaned
    }
  }
  return null
}

/**
 * McCabe complexity over this function's own body.
 *
 * Nested functions are skipped, which is the whole reason this is not a regex
 * count: a small function that happens to contain a branchy callback is not
 * itself complex, and folding the callback's branches into it produces a number
 * that no amount of refactoring the outer function can bring down.
 *
 * `default:` is NOT counted. It is where control lands when nothing matched,
 * not a decision of its own; counting it inflates every exhaustive switch by
 * one. Optional chaining (`?.`) is likewise uncounted — it is a null guard, not
 * a branch a test has to cover separately.
 */
const DECISION_TYPES: ReadonlySet<string> = new Set([
  'IfStatement',
  'ForStatement',
  'ForOfStatement',
  'ForInStatement',
  'WhileStatement',
  'DoWhileStatement',
  'CatchClause',
  'ConditionalExpression'
])

function isDecision(node: t.Node): boolean {
  if (DECISION_TYPES.has(node.type)) return true
  if (node.type === 'SwitchCase') return node.test !== null && node.test !== undefined
  if (node.type === 'LogicalExpression') {
    return node.operator === '&&' || node.operator === '||' || node.operator === '??'
  }
  return false
}

function cyclomaticComplexity(fn: t.Function): number {
  let complexity = 1

  const visit = (node: t.Node): void => {
    if (isDecision(node)) complexity++
    forEachChild(node, (child) => {
      if (isFunctionNode(child)) return
      visit(child)
    })
  }

  forEachChild(fn, (child) => {
    if (isFunctionNode(child)) return
    visit(child)
  })
  return complexity
}

function lineCountOf(node: t.Node): number {
  const loc = node.loc
  if (loc === null || loc === undefined) return 0
  return loc.end.line - loc.start.line + 1
}

function fillFunction(
  draft: DraftNode,
  fn: t.Function,
  name: string,
  visibility: Visibility | null,
  docHosts: readonly (t.Node | null | undefined)[]
): void {
  const params = paramsOf(fn.params)
  const returnType = printType(fn.returnType)

  draft.params = params
  draft.returnType = returnType
  draft.signature = signatureOf(name, params, returnType)
  draft.visibility = visibility
  draft.isAsync = fn.async === true
  draft.isGenerator = fn.generator === true
  draft.jsDoc = jsDocOf(docHosts)
  draft.metrics = {
    cyclomaticComplexity: cyclomaticComplexity(fn),
    lineCount: lineCountOf(fn),
    paramCount: fn.params.length
  }
  draft.category = declarationCategory(visibility, draft.isAsync, draft.isGenerator)
}

/**
 * The text an unresolved call is labelled with.
 *
 * Deliberately not `describeExpression`: that one is shared with the legacy
 * Mermaid diagram and changing its `MemberExpression` handling would change a
 * string the Visualizer's e2e test asserts on. A computed callee renders as
 * `handlers[…]` rather than being invented a name.
 */
function calleeLabel(callee: t.Node): string {
  if (callee.type === 'Identifier') return callee.name
  if (callee.type === 'ThisExpression') return 'this'
  if (callee.type === 'Super') return 'super'
  if (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') {
    const object = calleeLabel(callee.object)
    if (!callee.computed && callee.property.type === 'Identifier') {
      return `${object}.${callee.property.name}`
    }
    if (callee.property.type === 'PrivateName') return `${object}.#${callee.property.id.name}`
    return `${object}[…]`
  }
  if (callee.type === 'CallExpression' || callee.type === 'OptionalCallExpression') {
    return `${calleeLabel(callee.callee)}()`
  }
  return describeExpression(callee)
}

/** Names a class or object member, or null when the key is computed. */
function memberName(key: t.Node, computed: boolean): string | null {
  if (key.type === 'PrivateName') return `#${key.id.name}`
  if (computed) return null
  if (key.type === 'Identifier') return key.name
  if (key.type === 'StringLiteral') return key.value
  if (key.type === 'NumericLiteral') return String(key.value)
  return null
}

/* ------------------------ selection: control flow ------------------------ */

/**
 * An edge that has a source but not yet a target: the exit of a fragment,
 * waiting for whatever statement comes next. Carrying the kind and label along
 * is what lets `if (a) { … }` attach a *labelled* false edge to the statement
 * after it instead of an unlabelled one.
 */
interface PendingEdge {
  readonly from: string
  readonly kind: GraphEdgeKind
  readonly label: string | null
}

/** A statement that produced at least one node. */
interface FlowFragment {
  readonly entry: string
  readonly exits: readonly PendingEdge[]
}

/** A statement list. `entry` is null when nothing in it produced a node. */
interface FlowSequence {
  readonly entry: string | null
  readonly exits: readonly PendingEdge[]
}

/**
 * Where an abrupt jump lands. `break` and `continue` are not decoration: a
 * `switch` whose cases all `break` is a fan-out that reconverges, and drawing
 * each `break` as a dead end instead would claim the function ends there.
 */
interface FlowScope {
  /** Collector for an unlabelled `break`; null outside a loop or switch. */
  readonly breaks: PendingEdge[] | null
  /** Loop header an unlabelled `continue` jumps back to; null outside a loop. */
  readonly continueTo: string | null
}

const TOP_SCOPE: FlowScope = { breaks: null, continueTo: null }

/** Hints inherited from an `export` wrapper the declaration is nested inside. */
interface DeclarationHint {
  readonly visibility: Visibility
  /** Statement whose leading comments hold the JSDoc, when an export wraps it. */
  readonly docHost: t.Node | null
}

const PLAIN: DeclarationHint = { visibility: 'internal', docHost: null }

function asStatements(node: t.Statement): readonly t.Statement[] {
  return node.type === 'BlockStatement' ? node.body : [node]
}

/**
 * Chains a statement list, wiring each fragment's dangling exits into the next
 * fragment's entry.
 *
 * `seed` is how a parent hands its own outgoing edge in — the `true` edge of an
 * `if`, the body edge of a loop. It means an empty consequent does the right
 * thing for free: nothing consumes the seed, so it falls out as this
 * sequence's exit and lands on whatever follows the `if`.
 */
function walkStatements(
  builder: Builder,
  statements: readonly t.Statement[],
  scope: FlowScope,
  seed: readonly PendingEdge[] = []
): FlowSequence {
  let entry: string | null = null
  let pending: readonly PendingEdge[] = seed

  for (const statement of statements) {
    if (statement.type === 'BreakStatement' && statement.label === null) {
      if (scope.breaks !== null) scope.breaks.push(...pending)
      pending = []
      continue
    }
    if (statement.type === 'ContinueStatement' && statement.label === null) {
      if (scope.continueTo !== null) {
        for (const edge of pending) {
          addEdge(builder, edge.from, scope.continueTo, 'loop-back', edge.label)
        }
      }
      pending = []
      continue
    }

    const fragment = walkStatement(builder, statement, scope)
    // A declaration or a plain assignment produces no node; control passes
    // straight through it and the pending exits stay where they are.
    if (fragment === null) continue

    for (const edge of pending) addEdge(builder, edge.from, fragment.entry, edge.kind, edge.label)
    if (entry === null) entry = fragment.entry
    pending = fragment.exits
  }

  return { entry, exits: pending }
}

function walkStatement(
  builder: Builder,
  statement: t.Statement,
  scope: FlowScope,
  hint: DeclarationHint = PLAIN
): FlowFragment | null {
  switch (statement.type) {
    case 'BlockStatement': {
      const sequence = walkStatements(builder, statement.body, scope)
      return sequence.entry === null ? null : { entry: sequence.entry, exits: sequence.exits }
    }

    case 'LabeledStatement':
      return walkStatement(builder, statement.body, scope)

    case 'IfStatement':
      return walkIf(builder, statement, scope)

    case 'SwitchStatement':
      return walkSwitch(builder, statement, scope)

    case 'ForStatement':
    case 'ForOfStatement':
    case 'ForInStatement':
    case 'WhileStatement':
      return walkLoop(builder, statement, scope)

    case 'DoWhileStatement':
      return walkDoWhile(builder, statement, scope)

    case 'TryStatement':
      return walkTry(builder, statement, scope)

    case 'ReturnStatement': {
      const argument = statement.argument
      const text =
        argument === null || argument === undefined
          ? 'Return'
          : `Return ${describeExpression(argument)}`
      // Terminal: no exits. The legacy diagram gave a return an outgoing edge,
      // which drew flow continuing past a point where it cannot.
      return { entry: addNode(builder, 'return', text, 'terminal', statement).id, exits: [] }
    }

    case 'ThrowStatement': {
      const text = `Throw ${describeExpression(statement.argument)}`
      return { entry: addNode(builder, 'throw', text, 'terminal', statement).id, exits: [] }
    }

    case 'FunctionDeclaration': {
      emitFunction(
        builder,
        statement,
        functionName(statement, null),
        hint.visibility,
        [statement, hint.docHost],
        null
      )
      // Hoisted definition, not a step. Chaining it into the enclosing sequence
      // would claim the enclosing code runs the body at that point.
      return null
    }

    case 'ClassDeclaration': {
      emitClass(builder, statement, hint)
      return null
    }

    case 'VariableDeclaration':
      return walkVariableDeclaration(builder, statement, hint)

    case 'ExportNamedDeclaration': {
      const declaration = statement.declaration
      if (declaration === null || declaration === undefined) return null
      return walkStatement(builder, declaration, scope, {
        visibility: 'exported',
        docHost: statement
      })
    }

    case 'ExportDefaultDeclaration': {
      const declaration = statement.declaration
      if (declaration.type !== 'FunctionDeclaration' && declaration.type !== 'ClassDeclaration') {
        return null
      }
      return walkStatement(builder, declaration, scope, {
        visibility: 'default-exported',
        docHost: statement
      })
    }

    default:
      return chainCalls(builder, [statement])
  }
}

function walkIf(builder: Builder, statement: t.IfStatement, scope: FlowScope): FlowFragment {
  const node = addNode(
    builder,
    'if',
    `If (${describeExpression(statement.test)})`,
    'control',
    statement
  )

  const consequent = walkStatements(builder, asStatements(statement.consequent), scope, [
    { from: node.id, kind: 'true', label: 'true' }
  ])
  const exits: PendingEdge[] = [...consequent.exits]

  const alternate = statement.alternate
  if (alternate !== null && alternate !== undefined) {
    const otherwise = walkStatements(builder, asStatements(alternate), scope, [
      { from: node.id, kind: 'false', label: 'false' }
    ])
    exits.push(...otherwise.exits)
  } else {
    // No `else`: the false edge goes straight at whatever follows the `if`.
    // A synthetic merge node would be one more box for zero information.
    exits.push({ from: node.id, kind: 'false', label: 'false' })
  }

  return { entry: node.id, exits }
}

/**
 * A switch is a fan-out with an explicit fall-through rule, and both halves
 * matter.
 *
 * Whether a case falls through is read off its own exits rather than by
 * pattern-matching for a trailing `break`: `break`, `return` and `throw` all
 * leave the case with no dangling exit, so a case that still has one is
 * *precisely* a case that falls through. Assuming every case breaks would draw
 * flow the code does not have, which is the bug this whole file exists to fix.
 */
function walkSwitch(
  builder: Builder,
  statement: t.SwitchStatement,
  scope: FlowScope
): FlowFragment {
  const node = addNode(
    builder,
    'switch',
    `Switch (${describeExpression(statement.discriminant)})`,
    'control',
    statement
  )

  const breaks: PendingEdge[] = []
  const inner: FlowScope = { breaks, continueTo: scope.continueTo }

  const caseIds: string[] = []
  const caseExits: (readonly PendingEdge[])[] = []
  let hasDefault = false

  for (const switchCase of statement.cases) {
    const test = switchCase.test
    const isDefault = test === null || test === undefined
    if (isDefault) hasDefault = true

    const caption = isDefault ? 'default' : describeExpression(test)
    const caseNode = addNode(
      builder,
      'case',
      isDefault ? 'default' : `case ${caption}`,
      'control',
      switchCase
    )
    addEdge(builder, node.id, caseNode.id, 'case', caption)

    const sequence = walkStatements(builder, switchCase.consequent, inner, [
      { from: caseNode.id, kind: 'sequential', label: null }
    ])
    caseIds.push(caseNode.id)
    caseExits.push(sequence.exits)
  }

  for (let i = 0; i < caseExits.length; i++) {
    const exits = caseExits[i]
    if (exits === undefined || exits.length === 0) continue
    const next = caseIds[i + 1]
    if (next === undefined) {
      // Last case, no terminator: control leaves the switch.
      breaks.push(...exits)
      continue
    }
    for (const exit of exits) addEdge(builder, exit.from, next, 'sequential', 'falls through')
  }

  if (statement.cases.length === 0) {
    breaks.push({ from: node.id, kind: 'sequential', label: null })
  } else if (!hasDefault) {
    // Nothing matched is a real path out of the switch, and it is the one
    // people forget. Drawing it is cheap; omitting it hides a hole.
    breaks.push({ from: node.id, kind: 'false', label: 'no match' })
  }

  return { entry: node.id, exits: breaks }
}

/**
 * The enclosing scope is deliberately ignored: a loop shadows *both* jump
 * targets, because an unlabelled `break` and `continue` inside it bind to this
 * loop and never to anything outside. That is not true of `switch`, which
 * shadows `break` but forwards `continue` to the loop around it — see
 * `walkSwitch`. The parameter stays for dispatch uniformity with the other
 * walkers.
 */
function walkLoop(
  builder: Builder,
  statement: t.ForStatement | t.ForOfStatement | t.ForInStatement | t.WhileStatement,
  _scope: FlowScope
): FlowFragment {
  let kind: GraphNodeKind = 'for'
  let text = 'For loop'
  if (statement.type === 'WhileStatement') {
    kind = 'while'
    text = `While (${describeExpression(statement.test)})`
  } else if (statement.type === 'ForOfStatement') {
    text = `For of ${describeExpression(statement.right)}`
  } else if (statement.type === 'ForInStatement') {
    text = `For in ${describeExpression(statement.right)}`
  }

  const node = addNode(builder, kind, text, 'control', statement)
  const breaks: PendingEdge[] = []
  const inner: FlowScope = { breaks, continueTo: node.id }

  const body = walkStatements(builder, asStatements(statement.body), inner, [
    { from: node.id, kind: 'true', label: 'body' }
  ])

  for (const exit of body.exits) {
    // An empty body leaves the seed untouched; a self-edge would say the header
    // loops on itself, which is not what an empty body does.
    if (exit.from === node.id) continue
    addEdge(builder, exit.from, node.id, 'loop-back', null)
  }

  breaks.push({ from: node.id, kind: 'false', label: 'exit' })
  return { entry: node.id, exits: breaks }
}

/**
 * `do … while` is the one loop whose body runs before the test, so the entry is
 * the body and the loop-back edge hangs off the *true* branch of the test —
 * the mirror image of every other loop here.
 *
 * The enclosing scope is ignored for the same reason as in `walkLoop`.
 */
function walkDoWhile(
  builder: Builder,
  statement: t.DoWhileStatement,
  _scope: FlowScope
): FlowFragment {
  const node = addNode(
    builder,
    'dowhile',
    `Do while (${describeExpression(statement.test)})`,
    'control',
    statement
  )

  const breaks: PendingEdge[] = []
  const inner: FlowScope = { breaks, continueTo: node.id }
  const body = walkStatements(builder, asStatements(statement.body), inner)

  for (const exit of body.exits) addEdge(builder, exit.from, node.id, exit.kind, exit.label)
  if (body.entry !== null) addEdge(builder, node.id, body.entry, 'loop-back', 'true')

  breaks.push({ from: node.id, kind: 'false', label: 'exit' })
  return { entry: body.entry ?? node.id, exits: breaks }
}

function walkTry(builder: Builder, statement: t.TryStatement, scope: FlowScope): FlowFragment {
  const node = addNode(builder, 'try', 'Try', 'control', statement)

  const block = walkStatements(builder, statement.block.body, scope, [
    { from: node.id, kind: 'sequential', label: 'try' }
  ])
  const exits: PendingEdge[] = [...block.exits]

  const handler = statement.handler
  if (handler !== null && handler !== undefined) {
    const param = handler.param
    const caught = param === null || param === undefined ? null : describeExpression(param)
    const catchNode = addNode(
      builder,
      'catch',
      caught === null ? 'Catch' : `Catch (${caught})`,
      'control',
      handler
    )
    // The catch edge leaves the `try` node rather than the last statement of
    // the block: an exception can be thrown from anywhere inside, and pretending
    // it happens at one specific line would be a lie with a line number on it.
    addEdge(builder, node.id, catchNode.id, 'catch', 'catch')

    const caught_ = walkStatements(builder, handler.body.body, scope, [
      { from: catchNode.id, kind: 'sequential', label: null }
    ])
    exits.push(...caught_.exits)
  }

  const finalizer = statement.finalizer
  if (finalizer === null || finalizer === undefined) return { entry: node.id, exits }

  const finallyNode = addNode(builder, 'finally', 'Finally', 'control', finalizer)
  addEdge(builder, node.id, finallyNode.id, 'finally', 'finally')
  for (const exit of exits) {
    // Already covered by the 'finally' edge above when the block was empty.
    if (exit.from === node.id) continue
    addEdge(builder, exit.from, finallyNode.id, exit.kind, exit.label)
  }

  const cleanup = walkStatements(builder, finalizer.body, scope, [
    { from: finallyNode.id, kind: 'sequential', label: null }
  ])
  return { entry: node.id, exits: cleanup.exits }
}

function walkVariableDeclaration(
  builder: Builder,
  statement: t.VariableDeclaration,
  hint: DeclarationHint
): FlowFragment | null {
  const rest: t.Node[] = []

  for (const declarator of statement.declarations) {
    const init = declarator.init
    if (init !== null && init !== undefined && isFunctionNode(init)) {
      const name = declarator.id.type === 'Identifier' ? declarator.id.name : 'anonymous'
      emitFunction(builder, init, name, hint.visibility, [declarator, statement, hint.docHost], null)
      continue
    }
    rest.push(declarator)
  }

  return chainCalls(builder, rest)
}

/**
 * One node per call found in a statement, chained in the order they appear.
 *
 * Calls are the part of a straight-line statement worth drawing — everything
 * else is an assignment the reader can see in the editor. A `return foo()` is
 * deliberately *not* split into a call node and a return node: the return's
 * label already carries `foo()`, and two boxes for one statement makes the
 * common case noisier for no gain.
 */
function chainCalls(builder: Builder, roots: readonly t.Node[]): FlowFragment | null {
  const calls: AnyCall[] = []
  for (const root of roots) collectCalls(root, calls)
  if (calls.length === 0) return null

  let entry: string | null = null
  let previous: string | null = null

  for (const call of calls) {
    const node = addNode(builder, 'call', `Call: ${calleeLabel(call.callee)}()`, 'internal', call)
    if (entry === null) entry = node.id
    if (previous !== null) addEdge(builder, previous, node.id, 'sequential', null)
    previous = node.id
  }

  if (entry === null || previous === null) return null
  return { entry, exits: [{ from: previous, kind: 'sequential', label: null }] }
}

/**
 * A function node plus the control-flow graph of its body.
 *
 * A concise arrow (`() => x + 1`) has an expression body and no `return`
 * statement to hang a terminal off, so one is synthesised — the value really
 * does leave the function there, and a graph that ends in mid-air reads as a
 * bug in the analyser.
 */
function emitFunction(
  builder: Builder,
  fn: t.Function,
  name: string,
  visibility: Visibility | null,
  docHosts: readonly (t.Node | null | undefined)[],
  parentId: string | null
): DraftNode {
  const kind: GraphNodeKind =
    fn.type === 'ClassMethod' || fn.type === 'ClassPrivateMethod' || fn.type === 'ObjectMethod'
      ? 'method'
      : 'function'

  const node = addNode(builder, kind, `${name}()`, 'internal', fn)
  node.parentId = parentId
  fillFunction(node, fn, name, visibility, docHosts)

  const body = fn.body
  if (body.type === 'BlockStatement') {
    walkStatements(builder, body.body, TOP_SCOPE, [
      { from: node.id, kind: 'sequential', label: null }
    ])
    return node
  }

  const implicit = addNode(
    builder,
    'return',
    `Return ${describeExpression(body)}`,
    'terminal',
    body
  )
  addEdge(builder, node.id, implicit.id, 'sequential', null)
  return node
}

/**
 * A class node with its members hung off it by `parentId`.
 *
 * Containment is expressed as a parent link, never as an edge: a class does not
 * *flow* into its methods, and drawing an arrow there would put a class at the
 * top of every call chain it appears in.
 */
function emitClass(
  builder: Builder,
  cls: t.ClassDeclaration | t.ClassExpression,
  hint: DeclarationHint
): DraftNode {
  const name = cls.id === null || cls.id === undefined ? 'anonymous' : cls.id.name
  const node = addNode(builder, 'class', name, 'internal', cls)
  node.visibility = hint.visibility
  node.category = declarationCategory(hint.visibility, false, false)
  node.signature =
    cls.superClass === null || cls.superClass === undefined
      ? `class ${name}`
      : `class ${name} extends ${describeExpression(cls.superClass)}`
  node.jsDoc = jsDocOf([cls, hint.docHost])

  for (const member of cls.body.body) {
    if (member.type === 'ClassMethod' || member.type === 'ClassPrivateMethod') {
      const memberLabel = memberName(member.key, member.computed === true)
      const label = memberLabel ?? '[computed]'
      emitFunction(
        builder,
        member,
        member.kind === 'get' || member.kind === 'set' ? `${member.kind} ${label}` : label,
        'internal',
        [member],
        node.id
      )
      continue
    }
    if (member.type === 'ClassProperty' || member.type === 'ClassPrivateProperty') {
      const value = member.value
      if (value === null || value === undefined || !isFunctionNode(value)) continue
      const memberLabel =
        member.type === 'ClassProperty'
          ? memberName(member.key, member.computed === true)
          : memberName(member.key, false)
      emitFunction(builder, value, memberLabel ?? '[computed]', 'internal', [member], node.id)
    }
  }

  return node
}

/* ---------------------------- file: call graph --------------------------- */

/**
 * Everything the second pass needs to turn a callee into a node id.
 *
 * `byBinding` is keyed by the node a Babel *binding* points at — a
 * `FunctionDeclaration`, a `VariableDeclarator`, a `ClassDeclaration` — because
 * that is what `scope.getBinding(name).path.node` hands back. `byContainer` is
 * keyed by the node that *owns* a call site, which is a different set: a
 * `ClassMethod` owns calls but nothing binds to it by name.
 */
interface FileTables {
  readonly byBinding: Map<t.Node, DraftNode>
  readonly byContainer: Map<t.Node, DraftNode>
  readonly methodsByClass: Map<string, Map<string, DraftNode>>
  readonly externals: Map<string, DraftNode>
  readonly exportedNames: Set<string>
  /** `export default someIdentifier` — the declaration itself carries no marker. */
  defaultExportName: string | null
  moduleEntry: DraftNode | null
}

function createTables(): FileTables {
  return {
    byBinding: new Map(),
    byContainer: new Map(),
    methodsByClass: new Map(),
    externals: new Map(),
    exportedNames: new Set(),
    defaultExportName: null,
    moduleEntry: null
  }
}

/**
 * `export { foo }` and `export default foo` name a symbol from a distance, so
 * the declaration itself has no syntactic marker to read. Collected up front.
 */
function collectExportNames(program: t.Program, tables: FileTables): void {
  for (const statement of program.body) {
    if (statement.type === 'ExportNamedDeclaration') {
      for (const specifier of statement.specifiers) {
        if (specifier.type !== 'ExportSpecifier') continue
        tables.exportedNames.add(specifier.local.name)
      }
      continue
    }
    if (statement.type === 'ExportDefaultDeclaration') {
      const declaration = statement.declaration
      if (declaration.type === 'Identifier') tables.defaultExportName = declaration.name
    }
  }
}

function visibilityOf(path: NodePath, name: string, tables: FileTables): Visibility {
  // Two levels is enough for every real shape: `export function f` (one), and
  // `export const f = …` where the declarator sits under a VariableDeclaration
  // under the export (two).
  let current: NodePath | null = path.parentPath
  for (let depth = 0; depth < 2 && current !== null; depth++) {
    if (current.node.type === 'ExportDefaultDeclaration') return 'default-exported'
    if (current.node.type === 'ExportNamedDeclaration') return 'exported'
    current = current.parentPath
  }
  if (tables.defaultExportName === name) return 'default-exported'
  if (tables.exportedNames.has(name)) return 'exported'
  return 'internal'
}

/** The nearest enclosing declaration we recorded, or the module itself. */
function ownerOf(builder: Builder, path: NodePath, tables: FileTables): DraftNode {
  let current: NodePath | null = path.parentPath
  while (current !== null) {
    const owner = tables.byContainer.get(current.node)
    if (owner !== undefined) return owner
    current = current.parentPath
  }
  return moduleEntry(builder, tables, path)
}

function moduleEntry(builder: Builder, tables: FileTables, path: NodePath): DraftNode {
  const existing = tables.moduleEntry
  if (existing !== null) return existing

  // Created lazily: a file whose every call sits inside a function never grows
  // this node, and an empty "top level" box on such a file is pure noise.
  const program = path.findParent((parent) => parent.node.type === 'Program')
  const anchor = program === null ? path.node : program.node
  const node = addNode(builder, 'entry', 'Module top-level', 'internal', anchor)
  node.visibility = 'internal'
  tables.moduleEntry = node
  return node
}

function externalNode(builder: Builder, tables: FileTables, callee: t.Node): DraftNode {
  const label = calleeLabel(callee)
  const existing = tables.externals.get(label)
  // Deduped by name: `console.log` called forty times is one box, not forty.
  if (existing !== undefined) return existing

  const node = addNode(builder, 'leaf', `${label}()`, 'external', callee)
  tables.externals.set(label, node)
  return node
}

function enclosingClass(path: NodePath, tables: FileTables): DraftNode | null {
  const found = path.findParent(
    (parent) => parent.node.type === 'ClassDeclaration' || parent.node.type === 'ClassExpression'
  )
  if (found === null) return null
  return tables.byContainer.get(found.node) ?? null
}

/**
 * Resolves a callee to a node declared in this file, or null for "not here".
 *
 * Identifier callees go through `scope.getBinding`, which is the whole reason
 * the declaration table is built in a separate first pass: function
 * declarations are hoisted, so a call on line 3 to a function declared on line
 * 40 is perfectly legal. A single top-to-bottom pass silently resolves that to
 * nothing and quietly draws an incomplete call graph, which is worse than
 * drawing none.
 */
function resolveCallee(
  path: NodePath<t.CallExpression> | NodePath<t.OptionalCallExpression>,
  tables: FileTables
): DraftNode | null {
  const callee = path.node.callee

  if (callee.type === 'Identifier') {
    const binding = path.scope.getBinding(callee.name)
    if (binding === undefined) return null
    return tables.byBinding.get(binding.path.node) ?? null
  }

  if (callee.type !== 'MemberExpression' && callee.type !== 'OptionalMemberExpression') return null
  if (callee.computed) return null
  if (callee.property.type !== 'Identifier') return null
  const name = callee.property.name

  // `this.foo()` — resolve against the enclosing class's own member table.
  if (callee.object.type === 'ThisExpression') {
    const owner = enclosingClass(path, tables)
    if (owner === null) return null
    return tables.methodsByClass.get(owner.id)?.get(name) ?? null
  }

  // `Foo.bar()` where `Foo` is a class declared in this file. Anything else —
  // an instance variable, a namespace import, a chained expression — needs a
  // type checker to resolve and is honestly reported as external instead.
  if (callee.object.type === 'Identifier') {
    const binding = path.scope.getBinding(callee.object.name)
    if (binding === undefined) return null
    const target = tables.byBinding.get(binding.path.node)
    if (target === undefined || target.kind !== 'class') return null
    return tables.methodsByClass.get(target.id)?.get(name) ?? null
  }

  return null
}

function linkCall(builder: Builder, from: DraftNode, to: DraftNode): void {
  if (from.id === to.id) {
    // Direct recursion. Recorded on the node, not as an edge — a self-loop
    // survives no layout pass legibly and `callees` already says it.
    if (!from.callees.includes(to.id)) from.callees.push(to.id)
    if (!from.callers.includes(from.id)) from.callers.push(from.id)
    return
  }
  if (from.callees.includes(to.id)) return
  from.callees.push(to.id)
  to.callers.push(from.id)
  addEdge(builder, from.id, to.id, 'calls', null)
}

function declareFunction(
  builder: Builder,
  tables: FileTables,
  fn: t.Function,
  name: string,
  kind: GraphNodeKind,
  path: NodePath,
  visibility: Visibility,
  docHosts: readonly (t.Node | null | undefined)[]
): DraftNode {
  const node = addNode(builder, kind, `${name}()`, 'internal', fn)
  fillFunction(node, fn, name, visibility, docHosts)

  const owner = nearestContainer(path, tables)
  node.parentId = owner === null ? null : owner.id

  tables.byContainer.set(fn, node)
  return node
}

/** Like `ownerOf`, but never invents a module entry — used for `parentId`. */
function nearestContainer(path: NodePath, tables: FileTables): DraftNode | null {
  let current: NodePath | null = path.parentPath
  while (current !== null) {
    const owner = tables.byContainer.get(current.node)
    if (owner !== undefined) return owner
    current = current.parentPath
  }
  return null
}

function collectDeclarations(builder: Builder, ast: t.File, tables: FileTables): void {
  babelTraverse(ast, {
    FunctionDeclaration(path: NodePath<t.FunctionDeclaration>) {
      const id = path.node.id
      if (id === null || id === undefined) return
      const node = declareFunction(
        builder,
        tables,
        path.node,
        id.name,
        'function',
        path,
        visibilityOf(path, id.name, tables),
        [path.node, path.parent]
      )
      tables.byBinding.set(path.node, node)
    },

    VariableDeclarator(path: NodePath<t.VariableDeclarator>) {
      const init = path.node.init
      if (init === null || init === undefined || !isFunctionNode(init)) return
      if (path.node.id.type !== 'Identifier') return
      const name = path.node.id.name
      const node = declareFunction(
        builder,
        tables,
        init,
        name,
        'function',
        path,
        visibilityOf(path, name, tables),
        [path.node, path.parent, path.parentPath?.parent ?? null]
      )
      tables.byBinding.set(path.node, node)
    },

    ClassDeclaration(path: NodePath<t.ClassDeclaration>) {
      const id = path.node.id
      if (id === null || id === undefined) return
      const visibility = visibilityOf(path, id.name, tables)
      const node = addNode(builder, 'class', id.name, 'internal', path.node)
      node.visibility = visibility
      node.category = declarationCategory(visibility, false, false)
      node.jsDoc = jsDocOf([path.node, path.parent])
      node.signature =
        path.node.superClass === null || path.node.superClass === undefined
          ? `class ${id.name}`
          : `class ${id.name} extends ${describeExpression(path.node.superClass)}`

      const container = nearestContainer(path, tables)
      node.parentId = container === null ? null : container.id

      tables.byBinding.set(path.node, node)
      tables.byContainer.set(path.node, node)
      tables.methodsByClass.set(node.id, new Map())
    },

    ClassMethod(path: NodePath<t.ClassMethod>) {
      declareMember(builder, tables, path, path.node, path.node.key, path.node.computed === true)
    },

    ClassPrivateMethod(path: NodePath<t.ClassPrivateMethod>) {
      declareMember(builder, tables, path, path.node, path.node.key, false)
    },

    ClassProperty(path: NodePath<t.ClassProperty>) {
      const value = path.node.value
      if (value === null || value === undefined || !isFunctionNode(value)) return
      declareMember(builder, tables, path, value, path.node.key, path.node.computed === true)
    }
  })
}

function declareMember(
  builder: Builder,
  tables: FileTables,
  path: NodePath,
  fn: t.Function,
  key: t.Node,
  computed: boolean
): void {
  const resolved = memberName(key, computed)
  const classNode = enclosingClass(path, tables)
  const kindPrefix =
    fn.type === 'ClassMethod' && (fn.kind === 'get' || fn.kind === 'set') ? `${fn.kind} ` : ''
  const name = `${kindPrefix}${resolved ?? '[computed]'}`

  // Methods are never "exported" in their own right; the class is. Marking them
  // exported would double-count the module's surface.
  const node = declareFunction(builder, tables, fn, name, 'method', path, 'internal', [
    path.node,
    fn
  ])
  node.parentId = classNode === null ? node.parentId : classNode.id

  // A computed key cannot be dialled by name, so it stays out of the lookup
  // table rather than being registered under a name it does not have.
  if (classNode === null || resolved === null) return
  const members = tables.methodsByClass.get(classNode.id)
  if (members === undefined) return
  if (!members.has(resolved)) members.set(resolved, node)
}

function resolveCalls(builder: Builder, ast: t.File, tables: FileTables): void {
  const handle = (path: NodePath<t.CallExpression> | NodePath<t.OptionalCallExpression>): void => {
    const from = ownerOf(builder, path, tables)
    const target = resolveCallee(path, tables)
    linkCall(builder, from, target ?? externalNode(builder, tables, path.node.callee))
  }

  babelTraverse(ast, {
    CallExpression(path: NodePath<t.CallExpression>) {
      handle(path)
    },
    OptionalCallExpression(path: NodePath<t.OptionalCallExpression>) {
      handle(path)
    }
  })
}

/* -------------------------------- fallback ------------------------------- */

/**
 * A line-per-node linear graph, used when the source will not parse or parses
 * to nothing structural.
 *
 * Same guarantee the legacy diagram makes, for the same reason: this runs on a
 * keystroke debounce, so most invocations see transiently invalid code, and a
 * blank panel reads as the feature being broken rather than as the user being
 * mid-edit. Pure string work — it cannot itself throw.
 */
function fallbackGraph(
  mode: GraphMode,
  code: string,
  startLine: number,
  error: string
): CodeGraph {
  const lines = sourceLines(code, startLine)
  const builder = createBuilder(startLine)

  let previous: string | null = null
  for (const entry of lines) {
    const location: SourceLocation = {
      startLine: entry.line,
      startColumn: 1,
      endLine: entry.line,
      endColumn: entry.text.length + 1
    }
    const node: DraftNode = {
      id: makeNodeId(builder.counter++, entry.line),
      kind: 'leaf',
      label: clip(entry.text),
      category: 'internal',
      location,
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
    builder.nodes.push(node)
    if (previous !== null) addEdge(builder, previous, node.id, 'sequential', null)
    previous = node.id
  }

  return finish(builder, mode, 'fallback', error)
}

function emptyGraph(mode: GraphMode): CodeGraph {
  return { mode, nodes: [], edges: [], source: 'fallback', error: null, rootIds: [] }
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== '' ? error.message : fallback
}

/* ------------------------------- entry points ---------------------------- */

/**
 * A control-flow graph of `code`, whose first line is `startLine` in the file.
 *
 * Never throws. Every failure — parse, walk, or a parse that yields nothing
 * structural — degrades to the linear fallback with `error` populated.
 */
export function buildSelectionGraph(code: string, startLine = 1): CodeGraph {
  if (code.trim() === '') return emptyGraph('selection')

  try {
    const ast = parseSource(code)
    const builder = createBuilder(startLine)
    walkStatements(builder, ast.program.body, TOP_SCOPE)

    if (builder.nodes.length === 0) {
      return fallbackGraph('selection', code, startLine, 'nothing structural to graph')
    }
    return finish(builder, 'selection', 'ast', null)
  } catch (error) {
    return fallbackGraph(
      'selection',
      code,
      startLine,
      messageOf(error, 'could not analyse the selection')
    )
  }
}

/**
 * A structure-and-call graph of a whole file.
 *
 * Two traversals, in this order, and the order is the point: declarations
 * first, calls second. Function declarations are hoisted, so resolving calls
 * during the same pass that discovers declarations misses every forward
 * reference — the graph still renders, still looks plausible, and is simply
 * missing edges. That is the failure mode this shape is designed to avoid.
 *
 * Never throws.
 */
export function buildFileGraph(code: string, startLine = 1): CodeGraph {
  if (code.trim() === '') return emptyGraph('file')

  try {
    const ast = parseSource(code)
    const builder = createBuilder(startLine)
    const tables = createTables()

    collectExportNames(ast.program, tables)
    collectDeclarations(builder, ast, tables)
    resolveCalls(builder, ast, tables)

    if (builder.nodes.length === 0) {
      return fallbackGraph('file', code, startLine, 'no functions, classes or calls found')
    }
    return finish(builder, 'file', 'ast', null)
  } catch (error) {
    return fallbackGraph('file', code, startLine, messageOf(error, 'could not analyse the file'))
  }
}
