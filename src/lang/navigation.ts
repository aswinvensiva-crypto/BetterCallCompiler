import { childrenOf, type Expr, type Ident, type Name, type Node, type Program } from './ast'
import { isTrivia, type Span } from './token'
import { tokenize } from './lexer'
import type { Declaration, Resolution, SymbolInfo, SymbolKind } from './symbols'
import { describeType, type TypeInfo } from './type-check'

/**
 * Navigation: what is at this offset, and where else is it?
 *
 * Everything an editor asks about a cursor — go to definition, find references,
 * rename, hover, outline — is one of two questions, and this module answers
 * both. Which symbol is the cursor on, and which nodes mention that symbol.
 *
 * ## Why this is small
 *
 * It is small because `symbols.ts` already did the work. `Resolution` carries
 * `uses`, `stores` and `declarations` as maps keyed by AST NODE, so "what does
 * this name refer to" is a map lookup rather than a second implementation of
 * the scoping rules. Matching references on `SymbolInfo` IDENTITY rather than
 * on the spelling of a name is what makes shadowing correct for free: two `x`
 * in nested scopes are two different `SymbolInfo` objects, so renaming the
 * inner one cannot touch the outer one, and no special case says so.
 *
 * That is the property Monaco's bundled TypeScript worker cannot offer here at
 * all, and it is the reason this pipe is worth building before anything else.
 *
 * ## Offsets, not positions
 *
 * Every entry point takes a UTF-16 code-unit offset, because that is what
 * `ITextModel.getOffsetAt` produces and what `Span.offset` already is. Nothing
 * in this file converts coordinates; spans carry 1-based line and column from
 * Part 1 and the worker hands them straight to the wire.
 *
 * Pure, like the rest of `src/lang/`: no node, no electron, no DOM.
 */

/* ------------------------------- walking ---------------------------------- */

/** Every node in the tree, parents before children, in source order. */
function* everyNode(node: Node): Generator<Node> {
  yield node
  for (const child of childrenOf(node)) yield* everyNode(child)
}

/**
 * Whether an offset lands on a span, counting the position just past its end.
 *
 * The inclusive end is what makes `foo|` behave like `fo|o`. Every editor
 * treats the caret immediately after an identifier as being on it, and F12
 * failing because the cursor sat at the end of the word is the kind of bug that
 * reads as the feature being broken rather than fussy.
 *
 * Safe for identifiers specifically: two of them can never be adjacent in BCC
 * without an operator, a delimiter or whitespace between them, so at most one
 * identifier can claim any offset.
 */
function touches(span: Span, offset: number): boolean {
  return offset >= span.offset && offset <= span.offset + span.length
}

function contains(span: Span, offset: number): boolean {
  return offset >= span.offset && offset < span.offset + span.length
}

/** The `Name` or `Ident` under the caret, if any. */
export function identifierAt(program: Program, offset: number): Name | Ident | null {
  let best: Name | Ident | null = null

  for (const node of everyNode(program)) {
    if (node.kind !== 'Name' && node.kind !== 'Ident') continue
    if (!touches(node.span, offset)) continue
    // A strict hit beats an end-of-span hit, so `a|b` — impossible today, but
    // possible the moment BCC grows a `.` — resolves to the one the caret is
    // genuinely inside rather than to whichever came first.
    if (best === null || contains(node.span, offset)) best = node
  }

  return best
}

/**
 * The symbol the caret is on, whether it was written as a read, a write or a
 * binding.
 *
 * Null for a name the resolver rejected: `symbols.ts` deliberately does not
 * record a use it could not resolve, so "cannot find 'x'" and "F12 does
 * nothing" are the same fact rather than two independent behaviours.
 */
export function symbolAt(
  program: Program,
  resolution: Resolution,
  offset: number
): { readonly symbol: SymbolInfo; readonly at: Name | Ident } | null {
  const at = identifierAt(program, offset)
  if (at === null) return null

  const symbol =
    at.kind === 'Name'
      ? resolution.uses.get(at)
      : (resolution.declarations.get(at) ?? resolution.stores.get(at))

  return symbol === undefined ? null : { symbol, at }
}

/* ------------------------------ definition -------------------------------- */

/** Where the symbol under the caret was declared. */
export function definitionAt(
  program: Program,
  resolution: Resolution,
  offset: number
): Span | null {
  return symbolAt(program, resolution, offset)?.symbol.declaration.span ?? null
}

/* ------------------------------ references -------------------------------- */

/**
 * Every mention of the symbol under the caret, in source order.
 *
 * Reads, writes and the declaration itself, because all three are places the
 * name appears and all three have to move together under a rename. The
 * declaration is included or not on request: Monaco's Find All References
 * shows it, and a rename needs it, but "who calls this" reads better without.
 */
export function referencesAt(
  program: Program,
  resolution: Resolution,
  offset: number,
  includeDeclaration: boolean
): Span[] {
  const target = symbolAt(program, resolution, offset)
  if (target === null) return []
  return referencesTo(program, resolution, target.symbol, includeDeclaration)
}

function referencesTo(
  program: Program,
  resolution: Resolution,
  symbol: SymbolInfo,
  includeDeclaration: boolean
): Span[] {
  const spans: Span[] = []

  for (const node of everyNode(program)) {
    if (node.kind === 'Name') {
      if (resolution.uses.get(node) === symbol) spans.push(node.span)
      continue
    }
    if (node.kind !== 'Ident') continue
    if (resolution.stores.get(node) === symbol) spans.push(node.span)
    else if (includeDeclaration && resolution.declarations.get(node) === symbol) {
      spans.push(node.span)
    }
  }

  return spans.sort((a, b) => a.offset - b.offset)
}

/* -------------------------------- rename ---------------------------------- */

export interface RenamePlan {
  /** The identifier the caret is on — what the inline rename box pre-fills. */
  readonly target: Span
  readonly placeholder: string
  /** Every span to rewrite, in source order, declaration included. */
  readonly spans: readonly Span[]
}

/**
 * Rejects a new name the lexer would not read back as one identifier.
 *
 * Checked by TOKENIZING it rather than by a regular expression, so the rule
 * cannot drift from the language: a keyword lexes as its keyword kind, a name
 * with a space lexes as two tokens, and `2x` lexes as a number followed by a
 * name. One call covers all three without restating what an identifier is.
 *
 * Returns the reason, or null when the name is fine.
 */
export function rejectNewName(newName: string): string | null {
  if (newName.length === 0) return 'a name cannot be empty'

  const tokens = tokenize(newName).filter((token) => !isTrivia(token.kind))
  // `tokenize` always ends with `eof`, so one identifier is two entries.
  const first = tokens[0]
  if (first === undefined || tokens.length !== 2 || tokens[1]?.kind !== 'eof') {
    return `'${newName}' is not a valid name`
  }
  if (first.kind !== 'identifier') {
    return `'${newName}' is not a valid name — it is ${
      first.kind === 'int' ? 'a number' : 'a keyword'
    }`
  }
  return null
}

export function renameAt(
  program: Program,
  resolution: Resolution,
  offset: number
): RenamePlan | null {
  const target = symbolAt(program, resolution, offset)
  if (target === null) return null

  return {
    target: target.at.span,
    placeholder: target.symbol.name,
    spans: referencesTo(program, resolution, target.symbol, true)
  }
}

/* -------------------------------- outline --------------------------------- */

export interface OutlineNode {
  readonly name: string
  /** The signature, as a reader would write it. Empty when there is nothing to add. */
  readonly detail: string
  readonly kind: SymbolKind
  /** The whole declaration — what the outline highlights when you hover a row. */
  readonly span: Span
  /** Just the name — where the cursor lands when you click the row. */
  readonly selection: Span
  readonly children: readonly OutlineNode[]
}

/**
 * The file's structure, for the outline and the breadcrumb.
 *
 * Built from the AST rather than from `Resolution.scope`, even though that tree
 * exists and is the right shape. A scope is not a symbol: the block inside an
 * `if` is a scope with no name and nothing to show, and the function scope has
 * no back-link to the declaration that opened it. Walking declarations directly
 * gives exactly the rows a reader expects, and the types still come from the
 * checker.
 *
 * Parameters are deliberately absent as rows. They are in the signature, which
 * is where a reader looks for them, and listing them as children of every
 * function turns a five-function file into a thirty-row outline.
 */
export function documentSymbols(
  program: Program,
  resolution: Resolution,
  types: TypeInfo
): OutlineNode[] {
  const typeOf = (ident: Ident): string => {
    const symbol = resolution.declarations.get(ident)
    if (symbol === undefined) return ''
    const type = types.symbolTypes.get(symbol)
    return type === undefined ? '' : describeType(type)
  }

  const nodesIn = (statements: readonly Node[]): OutlineNode[] => {
    const rows: OutlineNode[] = []

    for (const statement of statements) {
      if (statement.kind === 'Function') {
        rows.push({
          name: statement.name.text,
          detail: signatureOf(statement, typeOf),
          kind: 'function',
          span: statement.span,
          selection: statement.name.span,
          children: nodesIn(statement.body.statements)
        })
        continue
      }
      if (statement.kind === 'Let') {
        const type = typeOf(statement.name)
        rows.push({
          name: statement.name.text,
          detail: type === '' ? '' : `: ${type}`,
          kind: 'variable',
          span: statement.span,
          selection: statement.name.span,
          children: []
        })
        continue
      }
      // A `let` inside an `if` or a `while` still belongs in the outline: it is
      // a declaration the reader can jump to, and the block it sits in is not.
      if (statement.kind === 'Block') rows.push(...nodesIn(statement.statements))
      else if (statement.kind === 'If') {
        rows.push(...nodesIn(statement.thenBranch.statements))
        if (statement.elseBranch !== null) rows.push(...nodesIn([statement.elseBranch]))
      } else if (statement.kind === 'While') rows.push(...nodesIn(statement.body.statements))
    }

    return rows
  }

  return nodesIn(program.statements)
}

function signatureOf(
  declaration: Extract<Declaration, { kind: 'Function' }>,
  typeOf: (ident: Ident) => string
): string {
  const params = declaration.params
    .map((param) => {
      const written = param.type?.name ?? typeOf(param.name)
      return written === '' ? param.name.text : `${param.name.text}: ${written}`
    })
    .join(', ')
  const returns = declaration.returnType?.name ?? 'unit'
  return `(${params}) -> ${returns}`
}

/* --------------------------------- hover ---------------------------------- */

export interface HoverInfo {
  readonly text: string
  readonly span: Span
}

/**
 * What to show when the pointer rests on something.
 *
 * A symbol first, because a name is what a reader most often asks about, and
 * an expression's type second, so hovering `a + b` still says `int`. The
 * fallback is what makes hover feel like it understands the file rather than
 * only its identifiers.
 */
export function hoverAt(
  program: Program,
  resolution: Resolution,
  types: TypeInfo,
  offset: number
): HoverInfo | null {
  const target = symbolAt(program, resolution, offset)
  if (target !== null) {
    return { text: describeSymbol(target.symbol, types), span: target.at.span }
  }

  const expr = innermostExprAt(program, offset)
  if (expr === null) return null
  const type = types.types.get(expr)
  return type === undefined ? null : { text: describeType(type), span: expr.span }
}

function describeSymbol(symbol: SymbolInfo, types: TypeInfo): string {
  const type = types.symbolTypes.get(symbol)
  const rendered = type === undefined ? '?' : describeType(type)

  switch (symbol.kind) {
    case 'function':
      // `describeType` already renders a function type as `(int, int) -> int`;
      // the parameter NAMES are only in the declaration, so they come from it.
      return symbol.node.kind === 'Function'
        ? `fn ${symbol.name}${signatureOf(symbol.node, () => '')}`
        : `fn ${symbol.name}: ${rendered}`
    case 'parameter':
      return `parameter ${symbol.name}: ${rendered}`
    case 'variable':
      return `let ${symbol.name}: ${rendered}`
  }
}

const EXPRESSION_KINDS = new Set<Node['kind']>([
  'Int',
  'Bool',
  'Name',
  'Unary',
  'Binary',
  'Logical',
  'Call',
  'ErrorExpr'
])

function innermostExprAt(program: Program, offset: number): Expr | null {
  let best: Expr | null = null

  for (const node of everyNode(program)) {
    if (!EXPRESSION_KINDS.has(node.kind)) continue
    if (!contains(node.span, offset)) continue
    const expr = node as Expr
    if (best === null || expr.span.length <= best.span.length) best = expr
  }

  return best
}
