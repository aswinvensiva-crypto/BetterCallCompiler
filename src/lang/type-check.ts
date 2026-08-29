import type {
  BinaryOp,
  BlockStmt,
  Expr,
  FunctionDecl,
  Program,
  Stmt,
  TypeRef
} from './ast'
import { error, type Diagnostic } from './diagnostic'
import type { Resolution, SymbolInfo } from './symbols'

/**
 * The BCC type checker.
 *
 * Named `type-check.ts` and not `types.ts` so it does not collide with
 * `src/shared/types.ts` in every import list — a small thing that would have
 * cost an alias in a dozen files.
 *
 * Runs after `resolve`, which has already answered "which `x` is this?".
 * Everything here is about what a thing IS, and the split means neither pass
 * has to hold both questions at once.
 *
 * ## The error type is the whole diagnostic strategy
 *
 * One mistake should produce one message. Without a poison value, a single
 * undefined name turns into an error at every operator that touches it, and the
 * real cause is buried in the noise. So an expression the checker could not type
 * gets `error`, `error` is compatible with everything, and nothing about it is
 * ever reported again. Every rule below checks for it FIRST.
 *
 * ## It types a broken file too
 *
 * `ErrorExpr` types as `error`, so a file the user is halfway through typing
 * still gets symbol and type information rather than nothing. That matters for
 * the Observatory and for anything later that wants hover types — and it costs
 * nothing, because the poison rule already stops the cascade.
 */

export type Type =
  | { readonly kind: 'int' }
  | { readonly kind: 'bool' }
  | { readonly kind: 'unit' }
  | { readonly kind: 'function'; readonly params: readonly Type[]; readonly result: Type }
  /** Something already reported. Compatible with everything, never re-reported. */
  | { readonly kind: 'error' }

export const INT: Type = { kind: 'int' }
export const BOOL: Type = { kind: 'bool' }
export const UNIT: Type = { kind: 'unit' }
export const ERROR: Type = { kind: 'error' }

/** The type names BCC knows. Anything else is reported, not guessed at. */
const NAMED_TYPES: ReadonlyMap<string, Type> = new Map<string, Type>([
  ['int', INT],
  ['bool', BOOL],
  ['unit', UNIT]
])

export function describeType(type: Type): string {
  switch (type.kind) {
    case 'int':
      return 'int'
    case 'bool':
      return 'bool'
    case 'unit':
      return 'unit'
    case 'error':
      return 'unknown'
    case 'function':
      return `(${type.params.map(describeType).join(', ')}) -> ${describeType(type.result)}`
  }
}

/** Structural, so two identically-shaped function types are the same type. */
export function sameType(a: Type, b: Type): boolean {
  if (a.kind === 'function' && b.kind === 'function') {
    return (
      a.params.length === b.params.length &&
      a.params.every((param, index) => sameType(param, b.params[index] ?? ERROR)) &&
      sameType(a.result, b.result)
    )
  }
  return a.kind === b.kind
}

/** Poison spreads without being reported twice. */
function isError(type: Type): boolean {
  return type.kind === 'error'
}

export interface TypeInfo {
  /** Every expression's type, for hover and for the Observatory. */
  readonly types: ReadonlyMap<Expr, Type>
  readonly symbolTypes: ReadonlyMap<SymbolInfo, Type>
  readonly diagnostics: readonly Diagnostic[]
}

/** Which operators want what, in one table rather than in a switch. */
const ARITHMETIC = new Set<BinaryOp>(['+', '-', '*', '/', '%'])
const COMPARISON = new Set<BinaryOp>(['<', '<=', '>', '>='])
const EQUALITY = new Set<BinaryOp>(['==', '!='])

export function typeCheck(program: Program, resolution: Resolution): TypeInfo {
  const types = new Map<Expr, Type>()
  const symbolTypes = new Map<SymbolInfo, Type>()
  const diagnostics: Diagnostic[] = []

  /** The return type of the function being checked; null at the top level. */
  let expectedReturn: Type | null = null

  const record = (expr: Expr, type: Type): Type => {
    types.set(expr, type)
    return type
  }

  const resolveTypeRef = (ref: TypeRef | null, fallback: Type): Type => {
    if (ref === null) return fallback
    const named = NAMED_TYPES.get(ref.name)
    if (named !== undefined) return named
    diagnostics.push(
      error(
        'BCC0011',
        `there is no type called '${ref.name}' — BCC has int, bool and unit`,
        ref.span
      )
    )
    return ERROR
  }

  /* --------------------------- function signatures ------------------------ */

  /**
   * Every function's signature, computed before any body is checked.
   *
   * Mirrors the resolver hoisting the names: a signature has to exist before a
   * body that calls it can be checked, and requiring declaration order would
   * make mutual recursion impossible for reasons that have nothing to do with
   * types.
   */
  const signatureOf = (declaration: FunctionDecl): Type => ({
    kind: 'function',
    params: declaration.params.map((param) => resolveTypeRef(param.type, ERROR)),
    // No `-> T` means unit. A function that returns nothing is not an error.
    result: resolveTypeRef(declaration.returnType, UNIT)
  })

  const collectSignatures = (statements: readonly Stmt[]): void => {
    for (const statement of statements) {
      if (statement.kind !== 'Function') continue
      const symbol = resolution.declarations.get(statement.name)
      if (symbol === undefined) continue
      symbolTypes.set(symbol, signatureOf(statement))
    }
  }

  const typeOfSymbol = (symbol: SymbolInfo): Type => symbolTypes.get(symbol) ?? ERROR

  /* ------------------------------ expressions ----------------------------- */

  const check = (expr: Expr): Type => {
    switch (expr.kind) {
      case 'Int':
        return record(expr, INT)

      case 'Bool':
        return record(expr, BOOL)

      case 'ErrorExpr':
        // The parser already said what was wrong here.
        return record(expr, ERROR)

      case 'Name': {
        const symbol = resolution.uses.get(expr)
        // Absent means the resolver reported it. Silence, not a second message.
        return record(expr, symbol === undefined ? ERROR : typeOfSymbol(symbol))
      }

      case 'Unary': {
        const operand = check(expr.operand)
        if (isError(operand)) return record(expr, ERROR)

        const want = expr.operator === '-' ? INT : BOOL
        if (!sameType(operand, want)) {
          diagnostics.push(
            error(
              'BCC0013',
              `'${expr.operator}' cannot be applied to ${describeType(operand)}`,
              expr.operatorSpan
            )
          )
          return record(expr, ERROR)
        }
        return record(expr, want)
      }

      case 'Logical': {
        const left = check(expr.left)
        const right = check(expr.right)
        if (isError(left) || isError(right)) return record(expr, ERROR)

        for (const [side, type] of [
          [expr.left, left],
          [expr.right, right]
        ] as const) {
          if (!sameType(type, BOOL)) {
            diagnostics.push(
              error(
                'BCC0013',
                `'${expr.operator}' needs bool operands, but this one is ${describeType(type)}`,
                side.span
              )
            )
            return record(expr, ERROR)
          }
        }
        return record(expr, BOOL)
      }

      case 'Binary': {
        const left = check(expr.left)
        const right = check(expr.right)
        if (isError(left) || isError(right)) return record(expr, ERROR)

        if (EQUALITY.has(expr.operator)) {
          // Comparable only with itself, and only for the types that have
          // values worth comparing. `f == g` is rejected here rather than
          // silently comparing function identities.
          if (!sameType(left, right) || (left.kind !== 'int' && left.kind !== 'bool')) {
            diagnostics.push(
              error(
                'BCC0013',
                `'${expr.operator}' cannot compare ${describeType(left)} with ${describeType(right)}`,
                expr.operatorSpan
              )
            )
            return record(expr, ERROR)
          }
          return record(expr, BOOL)
        }

        const wantsInt = ARITHMETIC.has(expr.operator) || COMPARISON.has(expr.operator)
        if (wantsInt && (!sameType(left, INT) || !sameType(right, INT))) {
          diagnostics.push(
            error(
              'BCC0013',
              `'${expr.operator}' needs int operands, but found ${describeType(left)} and ${describeType(right)}`,
              expr.operatorSpan
            )
          )
          return record(expr, ERROR)
        }

        return record(expr, ARITHMETIC.has(expr.operator) ? INT : BOOL)
      }

      case 'Call': {
        const callee = check(expr.callee)
        const args = expr.args.map(check)

        if (isError(callee)) return record(expr, ERROR)

        if (callee.kind !== 'function') {
          diagnostics.push(
            error(
              'BCC0014',
              `this is a ${describeType(callee)}, not a function, so it cannot be called`,
              expr.callee.span
            )
          )
          return record(expr, ERROR)
        }

        if (args.length !== callee.params.length) {
          diagnostics.push(
            error(
              'BCC0015',
              `expected ${callee.params.length} argument${callee.params.length === 1 ? '' : 's'}, found ${args.length}`,
              expr.span
            )
          )
          // The result type is still known even though the call is wrong, so
          // the expression around it can keep being checked.
          return record(expr, callee.result)
        }

        args.forEach((actual, index) => {
          const expected = callee.params[index] ?? ERROR
          if (isError(actual) || isError(expected)) return
          if (sameType(actual, expected)) return
          diagnostics.push(
            error(
              'BCC0012',
              `argument ${index + 1} should be ${describeType(expected)}, but this is ${describeType(actual)}`,
              expr.args[index]?.span ?? expr.span
            )
          )
        })

        return record(expr, callee.result)
      }
    }
  }

  /** Reports a mismatch unless one side is already poisoned. */
  const expect = (actual: Type, wanted: Type, message: string, span: Diagnostic['span']): void => {
    if (isError(actual) || isError(wanted)) return
    if (sameType(actual, wanted)) return
    diagnostics.push(error('BCC0012', message, span))
  }

  /* ------------------------------- statements ----------------------------- */

  const checkStmt = (statement: Stmt): void => {
    switch (statement.kind) {
      case 'Let': {
        const initializer = check(statement.initializer)
        const symbol = resolution.declarations.get(statement.name)

        if (statement.type === null) {
          // Inferred. A `unit` binding is allowed: it is useless rather than
          // wrong, and the mistake it usually indicates gets a better message
          // at the point the value is used.
          if (symbol !== undefined) symbolTypes.set(symbol, initializer)
          return
        }

        const annotated = resolveTypeRef(statement.type, ERROR)
        expect(
          initializer,
          annotated,
          `'${statement.name.text}' is declared ${describeType(annotated)} but this is ${describeType(initializer)}`,
          statement.initializer.span
        )
        // The ANNOTATION wins even when the initializer disagrees. The user
        // said what they meant; taking the initializer's type instead would
        // report a second error at every later use.
        if (symbol !== undefined) symbolTypes.set(symbol, annotated)
        return
      }

      case 'Assign': {
        const value = check(statement.value)
        const symbol = resolution.stores.get(statement.target)
        if (symbol === undefined) return // the resolver reported it
        const target = typeOfSymbol(symbol)
        expect(
          value,
          target,
          `'${statement.target.text}' is ${describeType(target)} but this is ${describeType(value)}`,
          statement.value.span
        )
        return
      }

      case 'If':
        expectCondition(statement.condition, 'if')
        checkBlock(statement.thenBranch)
        if (statement.elseBranch !== null) checkStmt(statement.elseBranch)
        return

      case 'While':
        expectCondition(statement.condition, 'while')
        checkBlock(statement.body)
        return

      case 'Return': {
        if (expectedReturn === null) {
          diagnostics.push(
            error('BCC0017', 'return is only allowed inside a function', statement.span)
          )
          if (statement.value !== null) check(statement.value)
          return
        }

        if (statement.value === null) {
          expect(
            UNIT,
            expectedReturn,
            `this function returns ${describeType(expectedReturn)}, so return needs a value`,
            statement.span
          )
          return
        }

        const value = check(statement.value)
        expect(
          value,
          expectedReturn,
          `this function returns ${describeType(expectedReturn)}, but this is ${describeType(value)}`,
          statement.value.span
        )
        return
      }

      case 'Print': {
        const value = check(statement.value)
        if (isError(value)) return
        if (value.kind !== 'int' && value.kind !== 'bool') {
          diagnostics.push(
            error(
              'BCC0012',
              `print needs an int or a bool, but this is ${describeType(value)}`,
              statement.value.span
            )
          )
        }
        return
      }

      case 'ExprStmt':
        check(statement.expression)
        return

      case 'Block':
        checkBlock(statement)
        return

      case 'Function':
        checkFunction(statement)
        return

      case 'ErrorStmt':
        return
    }
  }

  const expectCondition = (condition: Expr, keyword: string): void => {
    const type = check(condition)
    expect(
      type,
      BOOL,
      `the ${keyword} condition must be a bool, but this is ${describeType(type)}`,
      condition.span
    )
  }

  const checkBlock = (block: BlockStmt): void => {
    collectSignatures(block.statements)
    for (const statement of block.statements) checkStmt(statement)
  }

  const checkFunction = (declaration: FunctionDecl): void => {
    const symbol = resolution.declarations.get(declaration.name)
    const signature = symbol === undefined ? signatureOf(declaration) : typeOfSymbol(symbol)
    const result = signature.kind === 'function' ? signature.result : ERROR

    declaration.params.forEach((param, index) => {
      const parameterSymbol = resolution.declarations.get(param.name)
      if (parameterSymbol === undefined) return
      symbolTypes.set(
        parameterSymbol,
        signature.kind === 'function' ? (signature.params[index] ?? ERROR) : ERROR
      )
    })

    const outer = expectedReturn
    expectedReturn = result
    checkBlock(declaration.body)
    expectedReturn = outer

    // A function that promises a value must actually produce one on every path.
    if (result.kind !== 'unit' && result.kind !== 'error' && !alwaysReturns(declaration.body)) {
      diagnostics.push(
        error(
          'BCC0016',
          `'${declaration.name.text}' returns ${describeType(result)}, but it can finish without returning`,
          declaration.name.span
        )
      )
    }
  }

  collectSignatures(program.statements)
  for (const statement of program.statements) checkStmt(statement)

  return {
    types,
    symbolTypes,
    diagnostics: diagnostics.sort((a, b) => a.span.offset - b.span.offset)
  }
}

/**
 * Does this statement definitely leave the function?
 *
 * Deliberately structural rather than a walk over a control-flow graph — the
 * CFG arrives in Part 5, and this analysis is the same one every teaching
 * compiler starts with because it is short enough to read in one sitting.
 *
 * The recursion is bounded by the parser's nesting limit, so a pathological
 * file cannot reach the stack through here.
 *
 * `while` is the interesting case. A loop with a non-constant condition may not
 * run at all, so it never counts. `while true` never exits normally, and BCC
 * has no `break` — which is exactly what makes that sound rather than a
 * convenient lie. Without this, `fn f() -> int { while true { } }` would be
 * reported as possibly not returning, which is the classic false positive.
 */
function alwaysReturns(statement: Stmt): boolean {
  switch (statement.kind) {
    case 'Return':
      return true

    case 'Block':
      return statement.statements.some(alwaysReturns)

    case 'If':
      return (
        statement.elseBranch !== null &&
        alwaysReturns(statement.thenBranch) &&
        alwaysReturns(statement.elseBranch)
      )

    case 'While':
      return statement.condition.kind === 'Bool' && statement.condition.value

    default:
      return false
  }
}
