import type {
  BlockStmt,
  Expr,
  FunctionDecl,
  Ident,
  LetStmt,
  Name,
  Param,
  Program,
  Stmt
} from './ast'
import { error, type Diagnostic } from './diagnostic'
import type { Span } from './token'

/**
 * Name resolution: which declaration does each name refer to?
 *
 * Runs before type checking and knows nothing about types. That order is not
 * arbitrary — you cannot type `x + 1` without first knowing which `x` is meant,
 * and keeping the two apart means each can be read on its own. It is also the
 * seam Part 12 memoises: an edit inside a function body changes types without
 * changing the scope tree.
 *
 * ## Two maps, because a binding is not a use
 *
 * `Ident` (a binding or store site) and `Name` (a read) are separate node types
 * in the AST precisely so this pass can tell them apart without inspecting a
 * parent. Declarations go in `declarations`, reads in `uses`, writes in
 * `stores`. Part 5 emits a def for the first and a use for the second, and
 * having them already separated is what makes that lowering a lookup.
 *
 * ## What is deliberately NOT here
 *
 * No types, no constant folding, no reachability. Just: every name, and what it
 * points at.
 */

export type SymbolKind = 'variable' | 'parameter' | 'function'

export type Declaration = LetStmt | Param | FunctionDecl

export interface SymbolInfo {
  readonly kind: SymbolKind
  readonly name: string
  /** Where the name was written. The span a "declared here" note would use. */
  readonly declaration: Ident
  /** The whole declaration, so the type checker can read a signature from it. */
  readonly node: Declaration
}

/**
 * The lexical structure of a file, for the Observatory's Symbols tab.
 *
 * Built here because the resolver walks exactly this shape anyway. Rebuilding
 * it later from the AST would be a second implementation of the scoping rules,
 * and two implementations of a scoping rule are two chances to disagree.
 */
export interface Scope {
  readonly kind: 'global' | 'function' | 'block'
  readonly symbols: readonly SymbolInfo[]
  readonly children: readonly Scope[]
  readonly span: Span
}

export interface Resolution {
  /** Every read, and what it reads. A `Name` absent from this map was reported. */
  readonly uses: ReadonlyMap<Name, SymbolInfo>
  /** Every write, and what it writes to. */
  readonly stores: ReadonlyMap<Ident, SymbolInfo>
  /** Every binding site, and the symbol it introduces. */
  readonly declarations: ReadonlyMap<Ident, SymbolInfo>
  readonly scope: Scope
  readonly diagnostics: readonly Diagnostic[]
}

interface Frame {
  readonly kind: Scope['kind']
  readonly bindings: Map<string, SymbolInfo>
  readonly order: SymbolInfo[]
  readonly children: Scope[]
  readonly span: Span
}

export function resolve(program: Program): Resolution {
  const uses = new Map<Name, SymbolInfo>()
  const stores = new Map<Ident, SymbolInfo>()
  const declarations = new Map<Ident, SymbolInfo>()
  const diagnostics: Diagnostic[] = []

  const stack: Frame[] = []

  const push = (kind: Scope['kind'], span: Span): Frame => {
    const frame: Frame = { kind, bindings: new Map(), order: [], children: [], span }
    stack.push(frame)
    return frame
  }

  const pop = (): Scope => {
    const frame = stack.pop()
    if (frame === undefined) throw new Error('scope stack underflow')
    const scope: Scope = {
      kind: frame.kind,
      symbols: frame.order,
      children: frame.children,
      span: frame.span
    }
    stack[stack.length - 1]?.children.push(scope)
    return scope
  }

  const current = (): Frame => {
    const frame = stack[stack.length - 1]
    if (frame === undefined) throw new Error('no scope')
    return frame
  }

  /**
   * Introduces a name in the current scope.
   *
   * Redeclaring in the SAME scope is an error; shadowing an outer one is not.
   * That split is the usual rule and the useful one: `let x` inside an `if`
   * whose outer `x` still matters is ordinary code, whereas two `let x` in one
   * block is almost always a mistake being made in slow motion.
   *
   * The second declaration still wins, so everything after it resolves to the
   * name the reader can see rather than to one the error said was wrong.
   */
  const declare = (kind: SymbolKind, ident: Ident, node: Declaration): SymbolInfo => {
    const frame = current()
    const symbol: SymbolInfo = { kind, name: ident.text, declaration: ident, node }

    const existing = frame.bindings.get(ident.text)
    if (existing !== undefined) {
      diagnostics.push(
        error(
          'BCC0009',
          `'${ident.text}' is already declared in this scope`,
          ident.span
        )
      )
    }

    frame.bindings.set(ident.text, symbol)
    frame.order.push(symbol)
    declarations.set(ident, symbol)
    return symbol
  }

  const lookup = (name: string): SymbolInfo | null => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const found = stack[i]?.bindings.get(name)
      if (found !== undefined) return found
    }
    return null
  }

  /* ------------------------------ expressions ----------------------------- */

  const walkExpr = (expr: Expr): void => {
    switch (expr.kind) {
      case 'Name': {
        const symbol = lookup(expr.text)
        if (symbol === null) {
          diagnostics.push(error('BCC0008', `cannot find '${expr.text}'`, expr.span))
          return
        }
        uses.set(expr, symbol)
        return
      }

      case 'Unary':
        walkExpr(expr.operand)
        return

      case 'Binary':
      case 'Logical':
        walkExpr(expr.left)
        walkExpr(expr.right)
        return

      case 'Call':
        walkExpr(expr.callee)
        for (const argument of expr.args) walkExpr(argument)
        return

      // Leaves, and the hole a broken expression leaves behind.
      case 'Int':
      case 'Bool':
      case 'ErrorExpr':
        return
    }
  }

  /* ------------------------------- statements ----------------------------- */

  /**
   * Declares every function in a list of statements before any of them is
   * walked.
   *
   * Without this, `fn fib(n: int) -> int { return fib(n - 1); }` cannot see
   * itself and mutual recursion between two functions is impossible — the
   * second would resolve, the first would not, purely because of the order they
   * were written in. Hoisting is what makes declaration order stop mattering
   * for functions, while `let` deliberately keeps mattering.
   */
  const hoistFunctions = (statements: readonly Stmt[]): void => {
    for (const statement of statements) {
      if (statement.kind !== 'Function') continue
      declare('function', statement.name, statement)
    }
  }

  const walkBlock = (block: BlockStmt, kind: Scope['kind'] = 'block'): void => {
    push(kind, block.span)
    hoistFunctions(block.statements)
    for (const statement of block.statements) walkStmt(statement)
    pop()
  }

  const walkFunction = (declaration: FunctionDecl): void => {
    if (current().kind !== 'global') {
      // Reported, but the name stays bound — `hoistFunctions` already put it in
      // the enclosing scope and it must stay there. BCC has no closures, so a
      // nested function is genuinely not part of the language, but unbinding
      // the name would turn one honest error into a "cannot find 'g'" at every
      // call, and the second error is the one the user would chase.
      //
      // Declaring it AGAIN here was the first version, and it produced a
      // spurious "already declared in this scope" beside every nesting error.
      diagnostics.push(
        error(
          'BCC0010',
          `'${declaration.name.text}' cannot be declared inside a block — BCC has no nested functions`,
          declaration.name.span
        )
      )
    }

    push('function', declaration.span)
    for (const param of declaration.params) {
      declare('parameter', param.name, param)
    }
    // The body's own scope is the function scope, not a nested block: a
    // parameter and a top-level `let` of the same name collide, which is what
    // the reader expects.
    hoistFunctions(declaration.body.statements)
    for (const statement of declaration.body.statements) walkStmt(statement)
    pop()
  }

  const walkStmt = (statement: Stmt): void => {
    switch (statement.kind) {
      case 'Let':
        // The initializer is resolved BEFORE the name is introduced, so
        // `let x = x + 1` refers to an outer `x` or to nothing — never to the
        // variable being defined.
        walkExpr(statement.initializer)
        declare('variable', statement.name, statement)
        return

      case 'Assign': {
        walkExpr(statement.value)
        const symbol = lookup(statement.target.text)
        if (symbol === null) {
          diagnostics.push(
            error('BCC0008', `cannot find '${statement.target.text}'`, statement.target.span)
          )
          return
        }
        if (symbol.kind === 'function') {
          diagnostics.push(
            error(
              'BCC0018',
              `'${statement.target.text}' is a function and cannot be assigned to`,
              statement.target.span
            )
          )
          return
        }
        stores.set(statement.target, symbol)
        return
      }

      case 'If':
        walkExpr(statement.condition)
        walkBlock(statement.thenBranch)
        if (statement.elseBranch !== null) {
          if (statement.elseBranch.kind === 'Block') walkBlock(statement.elseBranch)
          else walkStmt(statement.elseBranch)
        }
        return

      case 'While':
        walkExpr(statement.condition)
        walkBlock(statement.body)
        return

      case 'Return':
        if (statement.value !== null) walkExpr(statement.value)
        return

      case 'Print':
        walkExpr(statement.value)
        return

      case 'ExprStmt':
        walkExpr(statement.expression)
        return

      case 'Block':
        walkBlock(statement)
        return

      case 'Function':
        walkFunction(statement)
        return

      case 'ErrorStmt':
        return
    }
  }

  push('global', program.span)
  hoistFunctions(program.statements)
  for (const statement of program.statements) walkStmt(statement)

  const globalFrame = stack[stack.length - 1]
  const scope: Scope = {
    kind: 'global',
    symbols: globalFrame?.order ?? [],
    children: globalFrame?.children ?? [],
    span: program.span
  }
  stack.pop()

  return {
    uses,
    stores,
    declarations,
    scope,
    diagnostics: diagnostics.sort((a, b) => a.span.offset - b.span.offset)
  }
}
