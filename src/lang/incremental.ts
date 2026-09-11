import { childrenOf, type FunctionDecl, type Name, type Node, type Program, type Stmt } from './ast'
import { TOP_LEVEL_FUNCTION } from './lower'
import type { Resolution } from './symbols'
import { describeType, type TypeInfo } from './type-check'
import type { Span } from './token'

/**
 * Part 12's firewall: what a function needs lowered, and the narrow signal that
 * decides whether it needs lowering AGAIN.
 *
 * `lower.ts` lowers a whole `Program` at once, and `Q_AST`/`Q_SYMBOLS`/`Q_TYPES`
 * in `lang-worker.ts` are whole-file queries that produce a new object graph on
 * every edit — deliberately, since a `Resolution`'s maps are keyed by the AST
 * node instances of the CURRENT parse and cannot be reused against a new one.
 * Wiring `Q_IR` to depend on those directly would mean editing any function
 * forces every OTHER function to re-lower too, because the engine's cheap
 * validation path sees a changed dependency and has no narrower one to fall
 * back on.
 *
 * This module is the narrower dependency: for one named function (or the
 * synthetic top-level one), it extracts exactly the facts lowering that
 * function actually reads — its own subtree, the set of names calls may
 * target, and the resolved kind/type of every name it reads — and reduces them
 * to a single comparable string. `lang-worker.ts` gives that string to the
 * query engine as the value a `lowerInput:` query produces, so editing one
 * function's body changes only ITS canonical string, and every other
 * function's `ir:`/`ssa:`/`pass:` query validates without recomputing.
 *
 * Pure by the same discipline as the rest of `src/lang`: no node, no electron,
 * no typescript, no DOM.
 */

export interface FunctionEntry {
  readonly name: string
  readonly span: Span
  /** True for the synthetic `<main>` gathering the file's top-level statements. */
  readonly isSynthetic: boolean
}

/** Every function the file will lower, `<main>` included, in source order. */
export function functionsOf(program: Program): readonly FunctionEntry[] {
  const entries: FunctionEntry[] = []
  for (const statement of program.statements) {
    if (statement.kind === 'Function') {
      entries.push({ name: statement.name.text, span: statement.span, isSynthetic: false })
    }
  }
  // Last, matching the order `lower()` itself appends it in.
  entries.push({ name: TOP_LEVEL_FUNCTION, span: program.span, isSynthetic: true })
  return entries
}

function loweredNamesOf(program: Program): ReadonlySet<string> {
  const names = new Set<string>([TOP_LEVEL_FUNCTION])
  for (const statement of program.statements) {
    if (statement.kind === 'Function') names.add(statement.name.text)
  }
  return names
}

/**
 * What `lowerFunction`/`lowerTopLevel` need for one function.
 *
 * `declaration`/`topLevelStatements` are mutually exclusive — exactly one is
 * non-null, matching which of the two lowering ever calls for a given name.
 * `resolution`/`typeInfo` are the FULL, fresh, whole-file objects: lowering a
 * call needs to resolve a name declared anywhere in the file, and slicing
 * those maps down to "just this function's part" would be a second resolver.
 * The firewall is `canonicalLowerInput` below, not this shape.
 */
export interface LowerInput {
  readonly declaration: FunctionDecl | null
  readonly topLevelStatements: readonly Stmt[] | null
  readonly span: Span
  readonly resolution: Resolution
  readonly typeInfo: TypeInfo
  readonly loweredNames: ReadonlySet<string>
}

/** Null when `name` no longer exists — renamed or deleted since the last ask. */
export function lowerInputFor(
  program: Program,
  resolution: Resolution,
  typeInfo: TypeInfo,
  name: string
): LowerInput {
  const loweredNames = loweredNamesOf(program)

  if (name === TOP_LEVEL_FUNCTION) {
    const topLevelStatements = program.statements.filter((statement) => statement.kind !== 'Function')
    return {
      declaration: null,
      topLevelStatements,
      span: program.span,
      resolution,
      typeInfo,
      loweredNames
    }
  }

  const declaration =
    program.statements.find(
      (statement): statement is FunctionDecl =>
        statement.kind === 'Function' && statement.name.text === name
    ) ?? null

  return {
    declaration,
    topLevelStatements: null,
    span: declaration?.span ?? program.span,
    resolution,
    typeInfo,
    loweredNames
  }
}

/**
 * The one place external information can flow INTO a function's lowering: a
 * name read that resolves to something declared outside it — almost always a
 * call to another top-level function. Reading `resolution.uses` walks past
 * shadowing for free, because it is already keyed by resolved identity rather
 * than by text.
 *
 * A store or a declaration never needs this: `resolution.stores`/`declarations`
 * only ever point at a binding inside the SAME function (BCC has no closures
 * and no cross-function assignment), so those are already covered by the
 * structural dump of the function's own subtree.
 */
function collectNameFacts(
  node: Node,
  resolution: Resolution,
  typeInfo: TypeInfo,
  out: string[]
): void {
  if (node.kind === 'Name') {
    const nameNode = node as Name
    const symbol = resolution.uses.get(nameNode)
    if (symbol === undefined) {
      out.push('use:?')
    } else {
      const type = typeInfo.symbolTypes.get(symbol)
      out.push(`use:${symbol.kind}:${symbol.name}:${type === undefined ? '?' : describeType(type)}`)
    }
  }

  for (const child of childrenOf(node)) collectNameFacts(child, resolution, typeInfo, out)
}

/**
 * Reduces a `LowerInput` to one string: identical strings before and after an
 * edit mean lowering this function would produce the same IR, so the query
 * engine can skip calling `lowerFunction`/`lowerTopLevel` at all.
 *
 * Three ingredients, and no others:
 *   1. The sorted list of lowerable names — covers a function anywhere in the
 *      file being renamed, added or removed, which changes what a `Call` may
 *      legally target.
 *   2. `JSON.stringify` of the function's own subtree, spans included. Spans
 *      are deliberate: if an earlier edit shifted this function down the file,
 *      its IR's spans have to be recomputed too, or the Observatory and the
 *      debugger would highlight the wrong lines forever. This is the one place
 *      the caller pays for a function that only MOVED — see `lang-worker.ts`'s
 *      note on `Q_IR`'s own span-free equality for how that cost is capped at
 *      one recompute rather than cascading into SSA and the passes.
 *   3. For every name the function reads, what it resolves to and that
 *      symbol's type — the only channel through which another function's
 *      signature can affect this one without touching this function's own
 *      text at all.
 */
export function canonicalLowerInput(input: LowerInput): string {
  const facts: string[] = [[...input.loweredNames].sort().join(',')]

  if (input.declaration !== null) {
    facts.push(JSON.stringify(input.declaration))
    collectNameFacts(input.declaration, input.resolution, input.typeInfo, facts)
  } else if (input.topLevelStatements !== null) {
    facts.push(JSON.stringify(input.topLevelStatements))
    for (const statement of input.topLevelStatements) {
      collectNameFacts(statement, input.resolution, input.typeInfo, facts)
    }
  } else {
    facts.push('missing')
  }

  return facts.join('|')
}

/** `examples/fib.bcc#fib` -> `{ relativePath: 'examples/fib.bcc', name: 'fib' }`. */
export function splitFunctionArgument(argument: string): { relativePath: string; name: string } {
  const hash = argument.indexOf('#')
  if (hash < 0) return { relativePath: argument, name: TOP_LEVEL_FUNCTION }
  return { relativePath: argument.slice(0, hash), name: argument.slice(hash + 1) }
}

export function functionArgument(relativePath: string, name: string): string {
  return `${relativePath}#${name}`
}
