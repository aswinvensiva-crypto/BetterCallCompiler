import { describe, expect, it } from 'vitest'
import { childrenOf, type Expr, type Node, type Stmt } from '../../src/lang/ast'
import { DIAGNOSTIC_TITLES, type DiagnosticCode } from '../../src/lang/diagnostic'
import { parseSource } from '../../src/lang/parser'

/**
 * The parser, and mostly its invariants.
 *
 * A wrong tree SHAPE is loud — a precedence test names the expression that
 * broke. Two other failures are silent, and the property tests below exist for
 * them:
 *
 * - a wrong SPAN still compiles and still runs, and surfaces five stages later
 *   as a click-to-source highlight landing on the wrong line;
 * - a parser that fails to CONSUME on some error path hangs, and in Part 3 that
 *   is a frozen editor window rather than a failing build.
 *
 * So the per-construct tests document the grammar, and the properties are what
 * actually protect it.
 */

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Parses, asserting the input was clean. Returns the top-level statements. */
function clean(source: string): readonly Stmt[] {
  const { program, diagnostics } = parseSource(source)
  expect(diagnostics, `unexpected diagnostics for ${JSON.stringify(source)}`).toEqual([])
  return program.statements
}

function codesFor(source: string): DiagnosticCode[] {
  return parseSource(source).diagnostics.map((diagnostic) => diagnostic.code)
}

/** The single expression in `print <source>;`, so expressions can be tested alone. */
function expressionOf(source: string): Expr {
  const [statement] = clean(`print ${source};`)
  if (statement?.kind !== 'Print') throw new Error(`not a print statement: ${source}`)
  return statement.value
}

/**
 * An expression as an s-expression: `1 + 2 * 3` becomes `(+ 1 (* 2 3))`.
 *
 * Precedence and associativity are claims about SHAPE, and shape is what a
 * nested-object assertion buries. Written this way, `(+ 1 (* 2 3))` versus
 * `(* (+ 1 2) 3)` is the difference at a glance.
 */
function shape(node: Expr): string {
  switch (node.kind) {
    case 'Int':
      return node.text
    case 'Bool':
      return String(node.value)
    case 'Name':
      return node.text
    case 'Unary':
      return `(${node.operator} ${shape(node.operand)})`
    case 'Binary':
    case 'Logical':
      return `(${node.operator} ${shape(node.left)} ${shape(node.right)})`
    case 'Call':
      return `(call ${shape(node.callee)}${node.args.map((arg) => ` ${shape(arg)}`).join('')})`
    case 'ErrorExpr':
      return '<error>'
  }
}

function shapeOf(source: string): string {
  return shape(expressionOf(source))
}

/** Every node in the tree, parents before children. */
function everyNode(root: Node): Node[] {
  const all: Node[] = [root]
  for (const child of childrenOf(root)) all.push(...everyNode(child))
  return all
}

/** The operator spans a node carries that are not themselves nodes. */
function innerSpans(node: Node): { readonly label: string; readonly span: Node['span'] }[] {
  switch (node.kind) {
    case 'Unary':
    case 'Binary':
    case 'Logical':
      return [{ label: `${node.kind} operator`, span: node.operatorSpan }]
    default:
      return []
  }
}

/**
 * Inputs the properties run over: real programs, half-typed programs, and
 * things that are not programs at all.
 *
 * The broken entries matter more than the working ones. A parser is only ever
 * asked to parse a complete file at the moment the user stops typing.
 */
const CORPUS: readonly string[] = [
  '',
  '   ',
  '// nothing but a comment',
  'let x = 1;',
  'let x: int = 1 + 2 * 3;',
  'let ok: bool = true && false || !true;',
  'x = x + 1;',
  'print x;',
  'print (1 + 2) * 3;',
  'f();',
  'f(1, 2, 3);',
  'f(g(h(1)));',
  '{ let x = 1; print x; }',
  'if x < 10 { print x; }',
  'if x { print 1; } else { print 2; }',
  'if a { print 1; } else if b { print 2; } else { print 3; }',
  'while i != 0 { i = i - 1; }',
  'fn add(a: int, b: int) -> int { return a + b; }',
  'fn main() { print add(1, 2); }',
  'fn nothing() { return; }',
  'fn fib(n: int) -> int {\n  if n < 2 { return n; }\n  return fib(n - 1) + fib(n - 2);\n}',
  // Broken, from here down.
  'let',
  'let x',
  'let x =',
  'let x = ;',
  'let = 1;',
  'let x: = 1;',
  'let 1 = 2;',
  'if',
  'if x',
  'if x {',
  'if {',
  'while',
  'fn',
  'fn f',
  'fn f(',
  'fn f(a',
  'fn f(a:',
  'fn f(,) {}',
  'fn f() ->',
  'return',
  'print',
  'print ;',
  '1 +',
  '+ 1;',
  '(((',
  ')))',
  '}}}',
  'f(1',
  'f(,)',
  'f() = 1;',
  '1 = 2;',
  'let x = @ 1;',
  '/* never closed',
  'The quick brown fox jumped over 42 lazy dogs!',
  '99999999999999999999999;',
  'x == = y;',
  'let x = 1 let y = 2;',
  'if x { print 1; } else',
  '{{{{',
  'fn f() { fn g() { } }'
]

/* -------------------------------------------------------------------------- */
/*  Properties                                                                 */
/* -------------------------------------------------------------------------- */

describe('parse — span invariants', () => {
  /**
   * The strongest assertion in this file.
   *
   * If every node's span contains its children's, then a click on any node in
   * the Observatory highlights a region that genuinely contains everything
   * under it — which is the whole reason spans are threaded from the lexer
   * onwards. Nearly every span mistake breaks this: a node spanned from the
   * wrong token, an error node placed where the parser was a moment ago rather
   * than where it is, an end taken from the wrong side of a recovery.
   */
  it('gives every node a span containing all of its children', () => {
    for (const source of CORPUS) {
      const { program } = parseSource(source)

      for (const node of everyNode(program)) {
        const start = node.span.offset
        const end = node.span.offset + node.span.length

        for (const child of childrenOf(node)) {
          const label = `${child.kind} inside ${node.kind} of ${JSON.stringify(source)}`
          expect(child.span.offset, `${label}: starts before parent`).toBeGreaterThanOrEqual(start)
          expect(
            child.span.offset + child.span.length,
            `${label}: ends after parent`
          ).toBeLessThanOrEqual(end)
        }

        for (const inner of innerSpans(node)) {
          const label = `${inner.label} in ${JSON.stringify(source)}`
          expect(inner.span.offset, `${label}: starts before its node`).toBeGreaterThanOrEqual(start)
          expect(
            inner.span.offset + inner.span.length,
            `${label}: ends after its node`
          ).toBeLessThanOrEqual(end)
        }
      }
    }
  })

  it('never produces a negative-length span', () => {
    for (const source of CORPUS) {
      for (const node of everyNode(parseSource(source).program)) {
        expect(
          node.span.length,
          `${node.kind} in ${JSON.stringify(source)}`
        ).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('lists children in source order', () => {
    // The Observatory renders the tree in the order `childrenOf` returns, and
    // Part 5 lowers in it. Out-of-order children would show a function's body
    // before its parameters, and evaluate them in that order too.
    for (const source of CORPUS) {
      for (const node of everyNode(parseSource(source).program)) {
        let previousOffset = -1
        for (const child of childrenOf(node)) {
          expect(
            child.span.offset,
            `${child.kind} out of order in ${node.kind} of ${JSON.stringify(source)}`
          ).toBeGreaterThanOrEqual(previousOffset)
          previousOffset = child.span.offset
        }
      }
    }
  })

  it('spans the program over the whole file, trivia included', () => {
    for (const source of CORPUS) {
      const { program } = parseSource(source)
      expect(program.span.offset, JSON.stringify(source)).toBe(0)
      expect(program.span.length, JSON.stringify(source)).toBe(source.length)
    }
  })

  it('reports every diagnostic inside the file', () => {
    for (const source of CORPUS) {
      for (const diagnostic of parseSource(source).diagnostics) {
        const label = `${diagnostic.code} on ${JSON.stringify(source)}`
        expect(diagnostic.span.offset, label).toBeGreaterThanOrEqual(0)
        expect(diagnostic.span.offset + diagnostic.span.length, label).toBeLessThanOrEqual(
          source.length
        )
      }
    }
  })
})

describe('parse — it never throws and always terminates', () => {
  /**
   * Seeded rather than `Math.random`, so a failure is reproducible from its
   * message rather than being a run that once went wrong.
   *
   * Termination is asserted by the test completing at all: a parser that fails
   * to consume on some error path loops forever, and vitest's timeout is what
   * catches it. That is a weaker guarantee than a proof — it shows the absence
   * of a hang on 400 inputs, not on every input — which is why the parser also
   * carries an explicit progress backstop rather than relying on this.
   */
  it('survives arbitrary input', () => {
    const alphabet = ' \n{}()<>=!&|+-*/%,;:@abcXY_019'
    let seed = 0x5eed

    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed
    }

    const words = ['let', 'if', 'else', 'while', 'fn', 'return', 'print', 'true', 'false']

    for (let run = 0; run < 400; run++) {
      let source = ''
      const length = next() % 60
      for (let i = 0; i < length; i++) {
        // Sprinkle in keywords, or the grammar is almost never entered and the
        // fuzz only ever exercises the "expected a statement" path.
        source +=
          next() % 8 === 0
            ? ` ${words[next() % words.length]} `
            : alphabet[next() % alphabet.length]
      }

      expect(() => parseSource(source), `threw on: ${JSON.stringify(source)}`).not.toThrow()

      const { program } = parseSource(source)
      for (const node of everyNode(program)) {
        expect(node.span.length, `negative span on: ${JSON.stringify(source)}`).toBeGreaterThanOrEqual(0)
        for (const child of childrenOf(node)) {
          expect(child.span.offset, `containment on: ${JSON.stringify(source)}`).toBeGreaterThanOrEqual(
            node.span.offset
          )
          expect(
            child.span.offset + child.span.length,
            `containment on: ${JSON.stringify(source)}`
          ).toBeLessThanOrEqual(node.span.offset + node.span.length)
        }
      }
    }
  })

  it('always returns a program, however broken the input', () => {
    for (const source of CORPUS) {
      const { program } = parseSource(source)
      expect(program.kind, JSON.stringify(source)).toBe('Program')
    }
  })
})

/* -------------------------------------------------------------------------- */
/*  The grammar                                                                */
/* -------------------------------------------------------------------------- */

describe('parse — statements', () => {
  it('parses a let binding without an annotation', () => {
    const [statement] = clean('let x = 1;')
    expect(statement).toMatchObject({
      kind: 'Let',
      name: { kind: 'Ident', text: 'x' },
      type: null,
      initializer: { kind: 'Int', value: 1 }
    })
  })

  it('parses a let binding with an annotation', () => {
    const [statement] = clean('let x: int = 1;')
    expect(statement).toMatchObject({ kind: 'Let', type: { kind: 'TypeRef', name: 'int' } })
  })

  it('accepts any type name, leaving which ones exist to the resolver', () => {
    // Shape, not legality: `Frobnicator` is a syntactically valid type.
    const [statement] = clean('let x: Frobnicator = 1;')
    expect(statement).toMatchObject({ type: { name: 'Frobnicator' } })
  })

  it('parses an assignment as a statement, not an expression', () => {
    const [statement] = clean('x = x + 1;')
    expect(statement).toMatchObject({
      kind: 'Assign',
      target: { kind: 'Ident', text: 'x' }
    })

    // The payoff: `if x = 1` cannot be mistyped for `if x == 1`, because an
    // assignment is not an expression and cannot appear in a condition.
    expect(codesFor('if x = 1 { }')).toContain('BCC0003')
  })

  it('distinguishes a store from a load', () => {
    // `x = x + 1` binds one name twice with different meanings, and the tree
    // says which is which: the target is an `Ident`, the read is a `Name`.
    const [statement] = clean('x = x + 1;')
    if (statement?.kind !== 'Assign') throw new Error('expected an assignment')
    expect(statement.target.kind).toBe('Ident')
    expect(shape(statement.value)).toBe('(+ x 1)')
  })

  it('parses if without parentheses around the condition', () => {
    const [statement] = clean('if x < 10 { print x; }')
    expect(statement).toMatchObject({ kind: 'If', elseBranch: null })
  })

  it('parses else as a block', () => {
    const [statement] = clean('if x { print 1; } else { print 2; }')
    expect(statement).toMatchObject({ kind: 'If', elseBranch: { kind: 'Block' } })
  })

  it('chains else if', () => {
    const [statement] = clean('if a { } else if b { } else { }')
    if (statement?.kind !== 'If') throw new Error('expected an if')
    expect(statement.elseBranch?.kind).toBe('If')
    if (statement.elseBranch?.kind !== 'If') throw new Error('expected an else-if')
    expect(statement.elseBranch.elseBranch?.kind).toBe('Block')
  })

  it('parses while', () => {
    const [statement] = clean('while i != 0 { i = i - 1; }')
    expect(statement).toMatchObject({ kind: 'While', body: { kind: 'Block' } })
  })

  it('parses a function with parameters and a return type', () => {
    const [statement] = clean('fn add(a: int, b: int) -> int { return a + b; }')
    expect(statement).toMatchObject({
      kind: 'Function',
      name: { text: 'add' },
      returnType: { name: 'int' }
    })
    if (statement?.kind !== 'Function') throw new Error('expected a function')
    expect(statement.params.map((param) => param.name.text)).toEqual(['a', 'b'])
    expect(statement.params.map((param) => param.type?.name)).toEqual(['int', 'int'])
  })

  it('parses a function with no parameters and no return type', () => {
    const [statement] = clean('fn main() { print 1; }')
    expect(statement).toMatchObject({ kind: 'Function', params: [], returnType: null })
  })

  it('parses return with and without a value', () => {
    expect(clean('fn f() { return; }')).toBeDefined()
    const [statement] = clean('fn f() -> int { return 1; }')
    if (statement?.kind !== 'Function') throw new Error('expected a function')
    expect(statement.body.statements[0]).toMatchObject({ kind: 'Return', value: { kind: 'Int' } })

    const [bare] = clean('fn f() { return; }')
    if (bare?.kind !== 'Function') throw new Error('expected a function')
    expect(bare.body.statements[0]).toMatchObject({ kind: 'Return', value: null })
  })

  it('parses a bare block', () => {
    const [statement] = clean('{ let x = 1; print x; }')
    expect(statement).toMatchObject({ kind: 'Block' })
    if (statement?.kind !== 'Block') throw new Error('expected a block')
    expect(statement.statements).toHaveLength(2)
  })

  it('parses a call as an expression statement', () => {
    const [statement] = clean('f(1);')
    expect(statement).toMatchObject({ kind: 'ExprStmt', expression: { kind: 'Call' } })
  })

  it('parses a nested function, leaving the rule against it to the resolver', () => {
    // Grammatically fine, and rejected in Part 4 with a message worth reading.
    // Refusing it here would cost the user "unexpected token 'fn'".
    const [statement] = clean('fn f() { fn g() { } }')
    if (statement?.kind !== 'Function') throw new Error('expected a function')
    expect(statement.body.statements[0]).toMatchObject({ kind: 'Function', name: { text: 'g' } })
  })
})

describe('parse — expression precedence', () => {
  it('binds multiplication tighter than addition', () => {
    expect(shapeOf('1 + 2 * 3')).toBe('(+ 1 (* 2 3))')
    expect(shapeOf('1 * 2 + 3')).toBe('(+ (* 1 2) 3)')
  })

  it('is left-associative at every arithmetic level', () => {
    // The bug this catches: giving the right operand the same binding power as
    // the operator, which lets it swallow the next one and turns `1 - 2 - 3`
    // into `1 - (2 - 3)` — the same digits, the wrong answer.
    expect(shapeOf('1 - 2 - 3')).toBe('(- (- 1 2) 3)')
    expect(shapeOf('1 / 2 / 3')).toBe('(/ (/ 1 2) 3)')
    expect(shapeOf('1 % 2 % 3')).toBe('(% (% 1 2) 3)')
  })

  it('binds arithmetic tighter than comparison, and comparison tighter than equality', () => {
    expect(shapeOf('1 + 2 < 3 * 4')).toBe('(< (+ 1 2) (* 3 4))')
    expect(shapeOf('a < b == c > d')).toBe('(== (< a b) (> c d))')
  })

  it('binds && tighter than ||', () => {
    expect(shapeOf('a && b || c')).toBe('(|| (&& a b) c)')
    expect(shapeOf('a || b && c')).toBe('(|| a (&& b c))')
  })

  it('binds equality tighter than &&', () => {
    expect(shapeOf('a == 1 && b == 2')).toBe('(&& (== a 1) (== b 2))')
  })

  it('binds prefix operators tighter than any infix one', () => {
    expect(shapeOf('-1 + 2')).toBe('(+ (- 1) 2)')
    expect(shapeOf('!a && b')).toBe('(&& (! a) b)')
    expect(shapeOf('-a * -b')).toBe('(* (- a) (- b))')
  })

  it('stacks prefix operators right to left', () => {
    expect(shapeOf('--1')).toBe('(- (- 1))')
    expect(shapeOf('!!a')).toBe('(! (! a))')
  })

  it('binds a call tighter than a prefix operator', () => {
    expect(shapeOf('-f(1)')).toBe('(- (call f 1))')
    expect(shapeOf('!f()')).toBe('(! (call f))')
  })

  it('lets parentheses override precedence', () => {
    expect(shapeOf('(1 + 2) * 3')).toBe('(* (+ 1 2) 3)')
    expect(shapeOf('(a || b) && c')).toBe('(&& (|| a b) c)')
  })

  it('keeps && and || as a different node from the arithmetic operators', () => {
    // Not cosmetic: they do not evaluate both sides, so Part 5 lowers them to a
    // branch and a join rather than to one instruction.
    expect(expressionOf('a && b').kind).toBe('Logical')
    expect(expressionOf('a + b').kind).toBe('Binary')
    expect(expressionOf('a == b').kind).toBe('Binary')
  })
})

describe('parse — calls and literals', () => {
  it('parses calls with zero, one and several arguments', () => {
    expect(shapeOf('f()')).toBe('(call f)')
    expect(shapeOf('f(1)')).toBe('(call f 1)')
    expect(shapeOf('f(1, 2, 3)')).toBe('(call f 1 2 3)')
  })

  it('parses nested and chained calls', () => {
    expect(shapeOf('f(g(1), h(2))')).toBe('(call f (call g 1) (call h 2))')
    // `f()()` has a tree. Whether it means anything is Part 4's question.
    expect(shapeOf('f()()')).toBe('(call (call f))')
  })

  it('parses int and bool literals', () => {
    expect(expressionOf('42')).toMatchObject({ kind: 'Int', value: 42 })
    expect(expressionOf('true')).toMatchObject({ kind: 'Bool', value: true })
    expect(expressionOf('false')).toMatchObject({ kind: 'Bool', value: false })
  })

  it('keeps the literal as written alongside its value', () => {
    // The Observatory shows the source; `007` is not `7` on screen.
    expect(expressionOf('007')).toMatchObject({ kind: 'Int', value: 7, text: '007' })
  })
})

/* -------------------------------------------------------------------------- */
/*  Spans, specifically                                                        */
/* -------------------------------------------------------------------------- */

describe('parse — spans point where a reader would look', () => {
  const at = (source: string, span: { offset: number; length: number }): string =>
    source.slice(span.offset, span.offset + span.length)

  it('includes the parentheses in the grouped expression span', () => {
    // Without this, the multiplication below would be spanned from the `1`, and
    // selecting it in the Observatory would highlight `1 + 2) * 3`.
    const source = 'print (1 + 2) * 3;'
    const expression = expressionOf('(1 + 2) * 3')
    if (expression.kind !== 'Binary') throw new Error('expected a multiplication')

    expect(at(source, expression.left.span)).toBe('(1 + 2)')
    expect(at(source, expression.span)).toBe('(1 + 2) * 3')
  })

  it('spans a statement from its first token to its semicolon', () => {
    const source = 'let x = 1 + 2;'
    const [statement] = clean(source)
    expect(at(source, statement!.span)).toBe(source)
  })

  it('spans a function from fn to its closing brace', () => {
    const source = 'fn add(a: int) -> int { return a; }'
    const [statement] = clean(source)
    expect(at(source, statement!.span)).toBe(source)
  })

  it('gives the operator its own span', () => {
    const source = 'print a + b;'
    const expression = expressionOf('a + b')
    if (expression.kind !== 'Binary') throw new Error('expected a binary')
    // So "cannot add a bool" can underline the `+` rather than the whole line.
    expect(at(source, expression.operatorSpan)).toBe('+')
  })

  it('reports a missing token just past the previous one, not on what turned up', () => {
    // Where tsc and rustc put it, and where a reader told "expected ';'" looks.
    const source = 'let x = 1\nprint x;'
    const [diagnostic] = parseSource(source).diagnostics

    expect(diagnostic?.code).toBe('BCC0003')
    expect(diagnostic?.span.length).toBe(0)
    expect(diagnostic?.span.offset).toBe('let x = 1'.length)
    expect(diagnostic?.span.startLine).toBe(1)
  })

  it('carries 1-based line and column through from the lexer', () => {
    const [statement] = clean('let a = 1;\nlet b = 2;')
    const [, second] = clean('let a = 1;\nlet b = 2;')
    expect(statement?.span.startLine).toBe(1)
    expect(second?.span.startLine).toBe(2)
    expect(second?.span.startColumn).toBe(1)
  })
})

/* -------------------------------------------------------------------------- */
/*  Recovery                                                                   */
/* -------------------------------------------------------------------------- */

describe('parse — a broken file still yields a usable tree', () => {
  it('keeps parsing after a missing semicolon', () => {
    const { program, diagnostics } = parseSource('let x = 1\nlet y = 2;\nprint y;')

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['BCC0003'])
    // The point of recovery: one typo costs one diagnostic, and the two
    // statements after it are parsed normally.
    expect(program.statements.map((statement) => statement.kind)).toEqual([
      'Let',
      'Let',
      'Print'
    ])
  })

  it('keeps the shape of an expression that is missing its right side', () => {
    // `1 +` is an addition with a hole, not a missing statement. Part 4 can
    // still walk it, and the Observatory can still draw it.
    const { program } = parseSource('print 1 + ;')
    const [statement] = program.statements
    if (statement?.kind !== 'Print') throw new Error('expected a print')
    expect(shape(statement.value)).toBe('(+ 1 <error>)')
  })

  it('drops an unrecognised character and parses around it', () => {
    // The lexer had nowhere to put a diagnostic; this is where it goes. And
    // because the error token never reaches the grammar, one stray character
    // costs one diagnostic instead of a cascade about a token no rule mentions.
    const { program, diagnostics } = parseSource('let x = @ 1;')

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['BCC0001'])
    expect(program.statements[0]).toMatchObject({
      kind: 'Let',
      initializer: { kind: 'Int', value: 1 }
    })
  })

  it('groups a run of unrecognised characters into one diagnostic', () => {
    expect(codesFor('let x = @@@@@ 1;')).toEqual(['BCC0001'])
  })

  it('reports an unterminated block comment', () => {
    expect(codesFor('let x = 1; /* and then')).toEqual(['BCC0002'])
  })

  it('recovers at the next statement after junk', () => {
    const { program } = parseSource(') ) ) let x = 1;')
    expect(program.statements.some((statement) => statement.kind === 'ErrorStmt')).toBe(true)
    expect(program.statements.some((statement) => statement.kind === 'Let')).toBe(true)
  })

  it('does not swallow the brace that closes a block', () => {
    // Recovery stops at `}`, so the junk inside costs the block nothing.
    const { program } = parseSource('fn f() { ) ) ) } fn g() { }')
    expect(
      program.statements
        .filter((statement) => statement.kind === 'Function')
        .map((statement) => (statement.kind === 'Function' ? statement.name.text : ''))
    ).toEqual(['f', 'g'])
  })

  it('ends a let binding whose name is missing, rather than inventing one', () => {
    // No stage downstream should ever see a binding the source does not
    // contain — Part 4 would report on a variable nobody wrote.
    const { program } = parseSource('let = 1;')
    expect(program.statements[0]?.kind).toBe('ErrorStmt')
    expect(codesFor('let = 1;')).toEqual(['BCC0003'])
  })

  it('drops a parameter whose name is missing, rather than inventing one', () => {
    const { program } = parseSource('fn f(, b: int) { }')
    const [statement] = program.statements
    if (statement?.kind !== 'Function') throw new Error('expected a function')
    expect(statement.params.every((param) => param.name.text.length > 0)).toBe(true)
  })

  it('rejects an assignment to something that is not a variable', () => {
    expect(codesFor('f() = 1;')).toEqual(['BCC0006'])
    expect(codesFor('1 = 2;')).toEqual(['BCC0006'])
  })

  it('reports an expression that cannot start, and only that', () => {
    // The hole is zero-width and consumes nothing, so the `;` is still there
    // for the statement to end on — one diagnostic for one mistake.
    expect(codesFor('print ;')).toEqual(['BCC0004'])
  })

  it('spans an unclosed construct past the last token it consumed', () => {
    // Found by the fuzz property, then pinned here. `{ return ` leaves a
    // `Return` whose missing value is a zero-width node at the current
    // position — which is PAST the last token the block consumed. Ending the
    // block at that token gave a parent that did not contain its own child.
    //
    // The TRAILING SPACE is the trigger, and the reason this needs a test of
    // its own rather than the obvious `{ return`: with no trivia at the end,
    // the last token happens to end exactly where the hole begins and the
    // too-short parent still contains it by luck. Every case below ends in
    // whitespace on purpose.
    for (const source of ['{ return ', 'f(1 + ', 'fn f() { return ', 'print f(1 ']) {
      for (const node of everyNode(parseSource(source).program)) {
        for (const child of childrenOf(node)) {
          expect(
            child.span.offset + child.span.length,
            `${child.kind} escapes ${node.kind} in ${JSON.stringify(source)}`
          ).toBeLessThanOrEqual(node.span.offset + node.span.length)
        }
      }
    }
  })

  it('reports an integer it cannot represent exactly', () => {
    // Past 2^53 the value in the node stops being the number that was written,
    // and every later stage would reason about a different program.
    expect(codesFor('print 99999999999999999999;')).toEqual(['BCC0005'])
    expect(codesFor('print 9007199254740991;')).toEqual([])
  })

  it('leaves an unclosed block well-formed', () => {
    const { program } = parseSource('fn f() { print 1;')
    const [statement] = program.statements
    if (statement?.kind !== 'Function') throw new Error('expected a function')
    expect(statement.body.statements).toHaveLength(1)
  })

  it('parses a program that is only a comment', () => {
    const { program, diagnostics } = parseSource('// nothing here\n')
    expect(diagnostics).toEqual([])
    expect(program.statements).toEqual([])
  })
})

describe('parse — the nesting limit', () => {
  /**
   * A file of ten thousand open parentheses is input a user can produce by
   * renaming a minified file to `.bcc`, and recursive descent runs on the
   * JavaScript stack. Without the limit this is a stack overflow, which in
   * Part 3 means the language worker dies and burns its restart budget.
   */
  it('stops rather than overflowing the stack, and reports once', () => {
    const source = `print ${'('.repeat(10_000)}1;`

    expect(() => parseSource(source)).not.toThrow()

    const { diagnostics } = parseSource(source)
    // Once, not once per level as the stack unwinds.
    expect(diagnostics.filter((diagnostic) => diagnostic.code === 'BCC0007')).toHaveLength(1)
  })

  it('stops on deeply nested blocks too', () => {
    const source = '{'.repeat(10_000)
    expect(() => parseSource(source)).not.toThrow()
    expect(codesFor(source)).toContain('BCC0007')
  })

  it('stops on a long else-if chain, which recurses without passing a block', () => {
    const source = `if a { }${' else if a { }'.repeat(10_000)}`
    expect(() => parseSource(source)).not.toThrow()
    expect(codesFor(source)).toContain('BCC0007')
  })

  it('accounts for the tokens it gave up on', () => {
    // Whatever was not parsed is still covered by the tree, so the Observatory
    // shows a region that was abandoned rather than a file that ends early.
    const source = `print ${'('.repeat(10_000)}1;`
    const { program } = parseSource(source)
    expect(program.statements.some((statement) => statement.kind === 'ErrorStmt')).toBe(true)
  })

  it('leaves ordinary nesting alone', () => {
    const source = `print ${'('.repeat(50)}1${')'.repeat(50)};`
    expect(codesFor(source)).toEqual([])
  })
})

describe('diagnostic codes', () => {
  it('describes every code it can emit', () => {
    // The `Record` is total, so this cannot fail at runtime — it fails at
    // compile time instead, which is the point. What this asserts is that the
    // titles are not blank.
    for (const [code, title] of Object.entries(DIAGNOSTIC_TITLES)) {
      expect(title.length, code).toBeGreaterThan(0)
    }
  })

  it('emits only codes it has declared', () => {
    const declared = new Set(Object.keys(DIAGNOSTIC_TITLES))
    for (const source of CORPUS) {
      for (const diagnostic of parseSource(source).diagnostics) {
        expect(declared.has(diagnostic.code), `undeclared: ${diagnostic.code}`).toBe(true)
        expect(diagnostic.message.length).toBeGreaterThan(0)
        expect(diagnostic.severity).toBe('error')
      }
    }
  })
})
