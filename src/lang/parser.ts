import type {
  BinaryOp,
  BlockStmt,
  Expr,
  Ident,
  IfStmt,
  LogicalOp,
  Param,
  Program,
  Stmt,
  TypeRef
} from './ast'
import { error, type Diagnostic } from './diagnostic'
import { tokenize } from './lexer'
import { describeKind, isTrivia, type Span, type Token, type TokenKind } from './token'

/**
 * The BCC parser: recursive descent, with a Pratt loop for expressions.
 *
 * Recursive descent for statements because each statement rule reads like the
 * grammar line it implements, which is the whole point of a compiler people are
 * meant to learn from. Pratt for expressions because thirteen binary operators
 * at six precedence levels would otherwise be six near-identical functions, and
 * adding an operator would mean adding a seventh — here it is one row in
 * `INFIX`.
 *
 * ## Two guarantees, inherited from the lexer
 *
 * **It never throws, and it always terminates.** Every error path consumes at
 * least one token, expression and block nesting is bounded, and no rule
 * recurses on a prefix it has not consumed. In Part 3 this parser runs inside a
 * worker on every keystroke, where a hang is a frozen window and an exception
 * is a dead worker burning its restart budget.
 *
 * **A broken file still yields a tree.** `ErrorExpr` and `ErrorStmt` fill the
 * holes, so the shape survives: `1 +` is a `Binary` with a missing right side,
 * not a missing statement. Everything downstream — the resolver, the
 * Observatory, Part 12's memoisation — keeps working on input the user is
 * halfway through typing.
 *
 * ## Where recovery happens, and where it does not
 *
 * At statement boundaries only, as tree-sitter does and for the same reason: a
 * statement is the largest unit a reader thinks of as self-contained, so
 * resyncing there discards the least. The cost is that a mangled *sub*-statement
 * construct — a broken parameter list, say — can report more than once before
 * the next boundary is reached. That is a deliberate ceiling on recovery
 * machinery, not an oversight.
 */

export interface ParseResult {
  readonly program: Program
  readonly diagnostics: readonly Diagnostic[]
}

/**
 * How deep expressions, blocks and `else if` chains may nest.
 *
 * Recursive descent runs on the JavaScript stack, so ten thousand open
 * parentheses would exhaust it — and that is input a user can produce by
 * renaming a minified file to `.bcc`, not input they have to construct on
 * purpose. Real code nests around twenty deep; 200 is an order of magnitude of
 * headroom and still far from the stack limit.
 *
 * Past the limit the parser reports once and stops, rather than reporting at
 * every level as it unwinds.
 */
const MAX_DEPTH = 200

/** Tokenize and parse. The convenience path; Part 12 will call `parse`. */
export function parseSource(source: string): ParseResult {
  return parse(tokenize(source))
}

/**
 * Parses a token stream.
 *
 * Takes tokens rather than text because that is the seam Part 12 memoises:
 * `text → tokens → ast`, so an edit that leaves the token stream unchanged —
 * reformatting whitespace, editing a comment — can reuse the tree by early
 * cutoff. A `parse(source)` signature would hide that seam inside the function.
 */
export function parse(tokens: readonly Token[]): ParseResult {
  const diagnostics: Diagnostic[] = []

  /* ---------------------------------------------------------------------- */
  /*  Spans                                                                  */
  /* ---------------------------------------------------------------------- */

  const spanFrom = (start: Span, end: Span): Span => ({
    offset: start.offset,
    length: end.offset + end.length - start.offset,
    startLine: start.startLine,
    startColumn: start.startColumn,
    endLine: end.endLine,
    endColumn: end.endColumn
  })

  /** Zero-width, at the start of `span`. Where a missing NODE goes. */
  const startOf = (span: Span): Span => ({
    offset: span.offset,
    length: 0,
    startLine: span.startLine,
    startColumn: span.startColumn,
    endLine: span.startLine,
    endColumn: span.startColumn
  })

  /** Zero-width, just past `span`. Where a missing TOKEN is reported. */
  const endOf = (span: Span): Span => ({
    offset: span.offset + span.length,
    length: 0,
    startLine: span.endLine,
    startColumn: span.endColumn,
    endLine: span.endLine,
    endColumn: span.endColumn
  })

  const ZERO: Span = {
    offset: 0,
    length: 0,
    startLine: 1,
    startColumn: 1,
    endLine: 1,
    endColumn: 1
  }

  /* ---------------------------------------------------------------------- */
  /*  The stream                                                             */
  /* ---------------------------------------------------------------------- */

  /**
   * Trivia is dropped, and so are error tokens — but every error token is
   * reported first.
   *
   * Dropping them rather than feeding them to the grammar is what makes
   * `let x = @ 1;` produce ONE diagnostic about `@` and an otherwise correct
   * tree, instead of a cascade about a token no rule mentions. It is the lexer's
   * "never throws" guarantee cashed in: the lexer had nowhere to put a
   * diagnostic, and this is where it goes.
   */
  const stream: Token[] = []
  for (const token of tokens) {
    if (isTrivia(token.kind)) continue

    if (token.kind === 'error') {
      diagnostics.push(
        token.text.startsWith('/*')
          ? error('BCC0002', 'this block comment is never closed', token.span)
          : error(
              'BCC0001',
              `${token.text.length === 1 ? 'unrecognised character' : 'unrecognised characters'} ${quote(token.text)}`,
              token.span
            )
      )
      continue
    }

    stream.push(token)
  }

  // `tokenize` always ends with one, but `parse` is exported and Part 12 will
  // hand it a memoised array. Every loop below stops on eof, so its absence
  // would be a hang rather than an error.
  const lastScanned = stream[stream.length - 1]
  if (lastScanned === undefined || lastScanned.kind !== 'eof') {
    const lastOverall = tokens[tokens.length - 1]
    stream.push({
      kind: 'eof',
      text: '',
      span: lastOverall === undefined ? ZERO : endOf(lastOverall.span)
    })
  }

  /**
   * The token every accessor falls back to.
   *
   * The stream always ends with eof and `advance` never moves past it, so no
   * index below can actually miss — but saying that once, here, keeps `peek`
   * and its callers total instead of scattering non-null assertions through
   * every rule.
   */
  const endToken: Token = stream[stream.length - 1] ?? { kind: 'eof', text: '', span: ZERO }

  let position = 0

  const peek = (): Token => stream[position] ?? endToken
  const check = (kind: TokenKind): boolean => peek().kind === kind
  const atEnd = (): boolean => peek().kind === 'eof'

  /** Never moves past eof, so a caller that forgets to check cannot run off. */
  const advance = (): Token => {
    const token = peek()
    if (!atEnd()) position++
    return token
  }

  const previous = (): Token => (position === 0 ? peek() : (stream[position - 1] ?? endToken))

  /** Where a missing token is reported: just past the last one that was there. */
  const beforeCurrent = (): Span => (position === 0 ? startOf(peek().span) : endOf(previous().span))

  /* ---------------------------------------------------------------------- */
  /*  Diagnostics and the depth limit                                        */
  /* ---------------------------------------------------------------------- */

  let depth = 0
  let bailed = false

  const report = (
    code: Diagnostic['code'],
    message: string,
    span: Span
  ): void => {
    // Silent once bailed: the whole point of the limit is to report once, not
    // once per level of an unwinding stack.
    if (!bailed) diagnostics.push(error(code, message, span))
  }

  const bail = (): void => {
    if (bailed) return
    diagnostics.push(
      error(
        'BCC0007',
        `nested more than ${MAX_DEPTH} levels deep; the rest of this file was not parsed`,
        peek().span
      )
    )
    bailed = true
  }

  /**
   * Consumes `kind`, or reports its absence without consuming anything.
   *
   * The diagnostic lands just past the PREVIOUS token rather than on whatever
   * turned up instead — the same place tsc and rustc put it, and where a reader
   * told "expected ';'" actually looks. Consuming nothing is what lets the
   * caller's recovery decide what to do next.
   */
  const expect = (kind: TokenKind, context: string): Token | null => {
    if (check(kind)) return advance()
    report(
      'BCC0003',
      `expected ${describeKind(kind)} ${context}, found ${describeKind(peek().kind)}`,
      beforeCurrent()
    )
    return null
  }

  /**
   * Skips to the next plausible statement boundary.
   *
   * Always consumes at least one token: recovery that consumes nothing is a
   * hang, and this is the only place in the parser where that could happen.
   * Stops on `}` so a bad statement inside a block does not swallow the brace
   * that closes it.
   */
  const synchronize = (): void => {
    if (!atEnd()) advance()

    while (!atEnd()) {
      if (previous().kind === 'semicolon') return
      if (check('rightBrace')) return
      if (STATEMENT_START.has(peek().kind)) return
      advance()
    }
  }

  const identOf = (token: Token): Ident => ({
    kind: 'Ident',
    text: token.text,
    span: token.span
  })

  /* ---------------------------------------------------------------------- */
  /*  Types                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * A written type name.
   *
   * Nothing here checks that the name exists — `int`, `bool` and `Frobnicator`
   * all parse. Which of them are real is a question about meaning, and Part 4
   * can answer it with a message worth reading.
   */
  const parseType = (): TypeRef | null => {
    if (!check('identifier')) {
      report(
        'BCC0003',
        `expected a type name, found ${describeKind(peek().kind)}`,
        beforeCurrent()
      )
      return null
    }
    const token = advance()
    return { kind: 'TypeRef', name: token.text, span: token.span }
  }

  /* ---------------------------------------------------------------------- */
  /*  Expressions                                                            */
  /* ---------------------------------------------------------------------- */

  const errorExpr = (): Expr => ({ kind: 'ErrorExpr', span: startOf(peek().span) })

  /**
   * The Pratt loop.
   *
   * `minBindingPower` is the tightest operator the caller has already claimed.
   * Left associativity falls out of giving each level `(lbp, rbp) = (n, n + 1)`:
   * a right operand parsed at `n + 1` refuses the same operator, so `1 - 2 - 3`
   * groups as `(1 - 2) - 3`.
   */
  const parseExpression = (minBindingPower = 0): Expr => {
    if (bailed) return errorExpr()
    if (depth >= MAX_DEPTH) {
      bail()
      return errorExpr()
    }
    depth++

    let left = parseUnary()

    for (;;) {
      if (bailed) break
      const op = INFIX.get(peek().kind)
      if (op === undefined || op.lbp < minBindingPower) break

      const operator = advance()
      const right = parseExpression(op.rbp)
      const span = spanFrom(left.span, right.span)

      left =
        op.kind === 'logical'
          ? {
              kind: 'Logical',
              operator: op.symbol,
              left,
              right,
              operatorSpan: operator.span,
              span
            }
          : {
              kind: 'Binary',
              operator: op.symbol,
              left,
              right,
              operatorSpan: operator.span,
              span
            }
    }

    depth--
    return left
  }

  /**
   * Prefix `-` and `!`.
   *
   * Collected into a list and applied in reverse rather than by recursing, so
   * a line of ten thousand `!` is a long loop instead of a deep stack. Right
   * associativity is preserved: `--x` is `-(-x)`.
   */
  const parseUnary = (): Expr => {
    const prefixes: Token[] = []
    while (!bailed && (check('minus') || check('not'))) prefixes.push(advance())

    let expr = parsePostfix()

    // Innermost first, so the last prefix written binds tightest.
    for (const operator of prefixes.reverse()) {
      expr = {
        kind: 'Unary',
        operator: operator.kind === 'minus' ? '-' : '!',
        operand: expr,
        operatorSpan: operator.span,
        span: spanFrom(operator.span, expr.span)
      }
    }

    return expr
  }

  /** Call arguments, as a postfix operator binding tighter than any prefix. */
  const parsePostfix = (): Expr => {
    let expr = parsePrimary()

    while (!bailed && check('leftParen')) {
      advance()
      const args: Expr[] = []

      if (!check('rightParen')) {
        for (;;) {
          const before = position
          args.push(parseExpression())
          // Nothing consumable here — `f(,)`. Stop and let the `)` below
          // report, rather than spinning on a token no rule accepts.
          if (position === before) break
          if (!check('comma')) break
          advance()
        }
      }

      const close = expect('rightParen', 'to close these arguments')
      expr = {
        kind: 'Call',
        callee: expr,
        args,
        // Unclosed, the call ends where parsing stopped — not at the last token
        // it managed to consume. An argument can end past that: `f(1 +` leaves
        // a zero-width hole for the missing operand at the current position,
        // and a parent that stopped earlier would not contain its own child.
        span: spanFrom(expr.span, close?.span ?? startOf(peek().span))
      }
    }

    return expr
  }

  const parsePrimary = (): Expr => {
    if (bailed) return errorExpr()
    const token = peek()

    switch (token.kind) {
      case 'int': {
        advance()
        const value = Number(token.text)
        // The bound is JavaScript's, not BCC's: past 2^53 the value in this
        // node stops being the number that was written, and every later stage
        // would be reasoning about a different program than the one on screen.
        // A narrower `int` range, if the VM picks one in Part 9, is a
        // type-check question and belongs there.
        if (!Number.isSafeInteger(value)) {
          report('BCC0005', `${token.text} is too large to represent exactly`, token.span)
        }
        return { kind: 'Int', value, text: token.text, span: token.span }
      }

      case 'true':
      case 'false': {
        advance()
        return { kind: 'Bool', value: token.kind === 'true', span: token.span }
      }

      case 'identifier': {
        advance()
        return { kind: 'Name', text: token.text, span: token.span }
      }

      case 'leftParen': {
        const open = advance()
        const inner = parseExpression()
        const close = expect('rightParen', 'to close this group')
        // No node for the parentheses. The tree SHAPE already records the
        // grouping — that is exactly what precedence climbing produces — and a
        // node whose only content is punctuation is a node all seven later
        // stages must remember to unwrap. What the parens do own is the span,
        // so it is widened onto the inner expression: without that,
        // `(1 + 2) * 3` would be a multiplication whose span starts inside the
        // parentheses and highlights `1 + 2) * 3`.
        return close === null ? inner : { ...inner, span: spanFrom(open.span, close.span) }
      }

      default: {
        report(
          'BCC0004',
          `expected an expression, found ${describeKind(token.kind)}`,
          beforeCurrent()
        )
        // Consumes nothing on purpose: the statement level above knows where
        // the next boundary is, and this level does not.
        return errorExpr()
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  Statements                                                             */
  /* ---------------------------------------------------------------------- */

  const parseStatement = (): Stmt => {
    switch (peek().kind) {
      case 'let':
        return parseLet()
      case 'if':
        return parseIf()
      case 'while':
        return parseWhile()
      case 'fn':
        return parseFunction()
      case 'return':
        return parseReturn()
      case 'print':
        return parsePrint()
      case 'leftBrace':
        return parseBlock()
      default: {
        if (!EXPRESSION_START.has(peek().kind)) {
          const start = peek()
          report('BCC0003', `expected a statement, found ${describeKind(start.kind)}`, start.span)
          synchronize()
          return { kind: 'ErrorStmt', span: spanFrom(start.span, previous().span) }
        }
        return parseExpressionStatement()
      }
    }
  }

  /**
   * `let NAME (':' TYPE)? '=' EXPR ';'`
   *
   * A missing NAME ends the statement — without it there is no binding, and
   * inventing one would have Part 4 reporting on a variable nobody wrote. A
   * missing `=` or `;` does not: the shape is still recoverable, so it is
   * reported and parsing continues, which keeps one typo to one diagnostic.
   */
  const parseLet = (): Stmt => {
    const start = advance()

    if (!check('identifier')) {
      report(
        'BCC0003',
        `expected a name after 'let', found ${describeKind(peek().kind)}`,
        beforeCurrent()
      )
      synchronize()
      return { kind: 'ErrorStmt', span: spanFrom(start.span, previous().span) }
    }

    const name = identOf(advance())

    let type: TypeRef | null = null
    if (check('colon')) {
      advance()
      type = parseType()
    }

    expect('assign', 'in this let binding')
    const initializer = parseExpression()
    const semicolon = expect('semicolon', 'after this let binding')

    return {
      kind: 'Let',
      name,
      type,
      initializer,
      span: spanFrom(start.span, semicolon?.span ?? initializer.span)
    }
  }

  /** `if EXPR BLOCK ('else' (BLOCK | IF))?` — no parentheses around the condition. */
  const parseIf = (): IfStmt => {
    // Guarded separately from blocks: an `else if` chain recurses here without
    // passing through `parseBlock`, so a file of ten thousand of them would
    // otherwise slip under the limit.
    if (bailed || depth >= MAX_DEPTH) {
      bail()
      const span = startOf(peek().span)
      return {
        kind: 'If',
        condition: errorExpr(),
        thenBranch: { kind: 'Block', statements: [], span },
        elseBranch: null,
        span
      }
    }
    depth++

    const start = advance()
    // Rust needs a no-struct-literal rule to parse `if x { }`, because `x { }`
    // could begin a struct literal. BCC has no expression that starts with `{`,
    // so the condition can simply be an expression and the brace is unambiguous.
    const condition = parseExpression()
    const thenBranch = parseBlock()

    let elseBranch: BlockStmt | IfStmt | null = null
    if (check('else')) {
      advance()
      elseBranch = check('if') ? parseIf() : parseBlock()
    }

    depth--
    return {
      kind: 'If',
      condition,
      thenBranch,
      elseBranch,
      span: spanFrom(start.span, (elseBranch ?? thenBranch).span)
    }
  }

  const parseWhile = (): Stmt => {
    const start = advance()
    const condition = parseExpression()
    const body = parseBlock()
    return { kind: 'While', condition, body, span: spanFrom(start.span, body.span) }
  }

  const parseReturn = (): Stmt => {
    const start = advance()
    const value = check('semicolon') ? null : parseExpression()
    const semicolon = expect('semicolon', "after 'return'")
    return {
      kind: 'Return',
      value,
      span: spanFrom(start.span, semicolon?.span ?? value?.span ?? start.span)
    }
  }

  const parsePrint = (): Stmt => {
    const start = advance()
    const value = parseExpression()
    const semicolon = expect('semicolon', 'after this print statement')
    return { kind: 'Print', value, span: spanFrom(start.span, semicolon?.span ?? value.span) }
  }

  /**
   * An expression statement, or an assignment.
   *
   * Both start with an expression, so they are told apart by what follows it.
   * Assignment is a STATEMENT and not an expression, which is what makes
   * `if x = 1 { }` a syntax error here rather than the bug it is in C.
   */
  const parseExpressionStatement = (): Stmt => {
    const start = peek()
    const expression = parseExpression()

    if (check('assign')) {
      advance()
      const value = parseExpression()
      const semicolon = expect('semicolon', 'after this assignment')
      const span = spanFrom(start.span, semicolon?.span ?? value.span)

      if (expression.kind === 'Name') {
        return {
          kind: 'Assign',
          target: { kind: 'Ident', text: expression.text, span: expression.span },
          value,
          span
        }
      }

      report('BCC0006', 'only a variable can be assigned to', expression.span)
      return { kind: 'ErrorStmt', span }
    }

    const semicolon = expect('semicolon', 'after this expression')
    return {
      kind: 'ExprStmt',
      expression,
      span: spanFrom(start.span, semicolon?.span ?? expression.span)
    }
  }

  const parseBlock = (): BlockStmt => {
    if (bailed || depth >= MAX_DEPTH) {
      bail()
      return { kind: 'Block', statements: [], span: startOf(peek().span) }
    }
    depth++

    const open = expect('leftBrace', 'to open a block')
    if (open === null) {
      // Without the brace there is no way to know where the block ends, and
      // guessing would swallow the rest of the file into it. An empty block
      // keeps the tree well-formed and lets the caller carry on at the next
      // statement.
      //
      // Placed at the CURRENT token, not after the previous one. A missing
      // token is reported where the reader looks for it; a missing NODE has to
      // sit where the parser actually is, or it lands before a sibling that was
      // already parsed — `if` at end of file would give an `If` whose condition
      // starts after its own then-branch, and whose span contains neither.
      depth--
      return { kind: 'Block', statements: [], span: startOf(peek().span) }
    }

    const statements: Stmt[] = []
    while (!check('rightBrace') && !atEnd() && !bailed) {
      const before = position
      statements.push(parseStatement())
      if (position === before) advance() // liveness backstop; see `parseProgram`
    }

    const close = expect('rightBrace', 'to close this block')
    depth--
    return {
      kind: 'Block',
      statements,
      // As in `parsePostfix`: unclosed, the block ends where parsing stopped.
      // `{ return` leaves a `Return` whose missing value sits at the current
      // position, which is past the last token the block consumed.
      span: spanFrom(open.span, close?.span ?? startOf(peek().span))
    }
  }

  /** `fn NAME '(' PARAMS ')' ('->' TYPE)? BLOCK` */
  const parseFunction = (): Stmt => {
    const start = advance()

    if (!check('identifier')) {
      report(
        'BCC0003',
        `expected a function name after 'fn', found ${describeKind(peek().kind)}`,
        beforeCurrent()
      )
      synchronize()
      return { kind: 'ErrorStmt', span: spanFrom(start.span, previous().span) }
    }

    const name = identOf(advance())
    const params: Param[] = []

    if (expect('leftParen', 'after the function name') !== null) {
      if (!check('rightParen')) {
        for (;;) {
          const before = position
          const param = parseParam()
          if (param !== null) params.push(param)
          if (position === before) break
          if (!check('comma')) break
          advance()
        }
      }
      expect('rightParen', 'to close the parameter list')
    }

    let returnType: TypeRef | null = null
    if (check('arrow')) {
      advance()
      returnType = parseType()
    }

    const body = parseBlock()
    return {
      kind: 'Function',
      name,
      params,
      returnType,
      body,
      span: spanFrom(start.span, body.span)
    }
  }

  /**
   * `NAME ':' TYPE` — the annotation is required.
   *
   * Required because the grammar says so, not because inference is hard: a
   * parameter has no initializer to infer from. Returns null rather than a
   * parameter with a made-up name, so no stage downstream ever sees a binding
   * the source does not contain.
   */
  const parseParam = (): Param | null => {
    if (!check('identifier')) {
      report(
        'BCC0003',
        `expected a parameter name, found ${describeKind(peek().kind)}`,
        beforeCurrent()
      )
      return null
    }

    const name = identOf(advance())
    let type: TypeRef | null = null
    if (expect('colon', 'after the parameter name') !== null) {
      type = parseType()
    }

    return { kind: 'Param', name, type, span: spanFrom(name.span, type?.span ?? name.span) }
  }

  /* ---------------------------------------------------------------------- */
  /*  The program                                                            */
  /* ---------------------------------------------------------------------- */

  const statements: Stmt[] = []

  while (!atEnd() && !bailed) {
    const before = position
    statements.push(parseStatement())

    // This should be unreachable: every error path above consumes at least one
    // token. It stays because the cost of being wrong is a frozen editor
    // window rather than a failed build, and because a fuzz corpus can only
    // show the absence of a hang on the inputs it happens to try.
    if (position === before) advance()
  }

  // Past the nesting limit, whatever is left is accounted for but not parsed.
  if (bailed && !atEnd()) {
    const start = peek()
    while (!atEnd()) advance()
    statements.push({ kind: 'ErrorStmt', span: spanFrom(start.span, previous().span) })
  }

  const first = tokens[0]
  const last = tokens[tokens.length - 1]

  return {
    // Spanned from the ORIGINAL tokens, trivia included, so "the program" and
    // "the file" are the same region even when the file opens with a comment.
    program: {
      kind: 'Program',
      statements,
      span: first === undefined || last === undefined ? ZERO : spanFrom(first.span, last.span)
    },
    diagnostics
  }
}

/* -------------------------------------------------------------------------- */
/*  Tables                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One row per infix operator: how tightly it binds on each side.
 *
 * `lbp` is what the operator claims from the left, `rbp` what it demands of its
 * right operand. `rbp = lbp + 1` makes a level left-associative — the right
 * operand is parsed at a power that refuses the same operator, so it cannot
 * absorb it. Precedence is then just the ordering of these numbers, and adding
 * an operator is adding a row.
 *
 * `&&` and `||` are tagged `logical` because they build a different node: they
 * do not evaluate both sides, and Part 5 lowers them to branches.
 */
type InfixOp =
  | { readonly kind: 'binary'; readonly symbol: BinaryOp; readonly lbp: number; readonly rbp: number }
  | { readonly kind: 'logical'; readonly symbol: LogicalOp; readonly lbp: number; readonly rbp: number }

const INFIX: ReadonlyMap<TokenKind, InfixOp> = new Map<TokenKind, InfixOp>([
  ['or', { kind: 'logical', symbol: '||', lbp: 1, rbp: 2 }],
  ['and', { kind: 'logical', symbol: '&&', lbp: 3, rbp: 4 }],
  ['equals', { kind: 'binary', symbol: '==', lbp: 5, rbp: 6 }],
  ['notEquals', { kind: 'binary', symbol: '!=', lbp: 5, rbp: 6 }],
  ['less', { kind: 'binary', symbol: '<', lbp: 7, rbp: 8 }],
  ['lessEqual', { kind: 'binary', symbol: '<=', lbp: 7, rbp: 8 }],
  ['greater', { kind: 'binary', symbol: '>', lbp: 7, rbp: 8 }],
  ['greaterEqual', { kind: 'binary', symbol: '>=', lbp: 7, rbp: 8 }],
  ['plus', { kind: 'binary', symbol: '+', lbp: 9, rbp: 10 }],
  ['minus', { kind: 'binary', symbol: '-', lbp: 9, rbp: 10 }],
  ['star', { kind: 'binary', symbol: '*', lbp: 11, rbp: 12 }],
  ['slash', { kind: 'binary', symbol: '/', lbp: 11, rbp: 12 }],
  ['percent', { kind: 'binary', symbol: '%', lbp: 11, rbp: 12 }]
])

/** What `synchronize` treats as a fresh start. */
const STATEMENT_START: ReadonlySet<TokenKind> = new Set<TokenKind>([
  'let',
  'if',
  'while',
  'fn',
  'return',
  'print',
  'leftBrace',
  'identifier'
])

/** What `parsePrimary` can begin with — the check that keeps recovery honest. */
const EXPRESSION_START: ReadonlySet<TokenKind> = new Set<TokenKind>([
  'int',
  'identifier',
  'true',
  'false',
  'minus',
  'not',
  'leftParen'
])

/** Caps a quoted run so a pasted paragraph does not become the message. */
function quote(text: string): string {
  return JSON.stringify(text.length > 24 ? `${text.slice(0, 24)}…` : text)
}
