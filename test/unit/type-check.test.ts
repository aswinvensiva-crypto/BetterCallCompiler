import { describe, expect, it } from 'vitest'
import { DIAGNOSTIC_TITLES, type Diagnostic, type DiagnosticCode } from '../../src/lang/diagnostic'
import { parseSource } from '../../src/lang/parser'
import { resolve } from '../../src/lang/symbols'
import { describeType, sameType, typeCheck, type Type } from '../../src/lang/type-check'

/**
 * Resolution and type checking.
 *
 * The plan asks for one test per diagnostic code asserting code, span and
 * message, and `atCode` below does exactly that in one line — the SPAN half is
 * the part worth the ceremony. A wrong code is caught by the first test that
 * names it; a wrong span puts a real error's squiggle under the wrong token,
 * which reads to a user as the compiler being confused about their program.
 *
 * The other theme is silence. A type checker that reports one mistake five
 * times is worse than one that reports it once, so several tests here assert an
 * EXACT diagnostic list rather than "contains".
 */

/** Runs the whole front end and returns every diagnostic, in source order. */
function checkAll(source: string): Diagnostic[] {
  const { program, diagnostics: parseDiagnostics } = parseSource(source)
  const resolution = resolve(program)
  const typed = typeCheck(program, resolution)
  return [...parseDiagnostics, ...resolution.diagnostics, ...typed.diagnostics].sort(
    (a, b) => a.span.offset - b.span.offset
  )
}

const codes = (source: string): DiagnosticCode[] =>
  checkAll(source).map((diagnostic) => diagnostic.code)

/**
 * The one diagnostic with `code`, plus the source text its span covers.
 *
 * Returning the underlined text rather than raw offsets is what makes a span
 * assertion readable: `expect(underlined).toBe('nope')` says what a user would
 * see, where `expect(offset).toBe(23)` says nothing anyone can check by eye.
 */
function atCode(source: string, code: DiagnosticCode): { message: string; underlined: string } {
  const found = checkAll(source).filter((diagnostic) => diagnostic.code === code)
  if (found.length === 0) {
    throw new Error(
      `no ${code} in ${JSON.stringify(source)} — got ${JSON.stringify(codes(source))}`
    )
  }
  const [first] = found
  if (first === undefined) throw new Error('unreachable')
  return {
    message: first.message,
    underlined: source.slice(first.span.offset, first.span.offset + first.span.length)
  }
}

function typeOfLet(source: string, name: string): Type {
  const { program } = parseSource(source)
  const resolution = resolve(program)
  const typed = typeCheck(program, resolution)

  for (const [ident, symbol] of resolution.declarations) {
    if (ident.text === name) return typed.symbolTypes.get(symbol) ?? { kind: 'error' }
  }
  throw new Error(`no binding called ${name}`)
}

/* -------------------------------------------------------------------------- */
/*  Programs that are correct                                                  */
/* -------------------------------------------------------------------------- */

describe('a correct program reports nothing', () => {
  const PROGRAMS: readonly string[] = [
    'let x = 1;',
    'let x: int = 1; let y: bool = true;',
    'let x = 1; x = x + 1;',
    'print 1 + 2 * 3;',
    'print true && false || !true;',
    'print 1 < 2 == 3 > 4;',
    'fn add(a: int, b: int) -> int { return a + b; }',
    'fn add(a: int, b: int) -> int { return a + b; }\nprint add(1, 2);',
    'fn nothing() { print 1; }\nnothing();',
    'fn nothing() -> unit { return; }',
    'fn fib(n: int) -> int {\n  if n < 2 { return n; }\n  return fib(n - 1) + fib(n - 2);\n}',
    'fn even(n: int) -> bool { if n == 0 { return true; } return odd(n - 1); }\n' +
      'fn odd(n: int) -> bool { if n == 0 { return false; } return even(n - 1); }',
    'let i = 0; while i < 10 { i = i + 1; }',
    '{ let x = 1; { let x = 2; print x; } print x; }',
    'fn loops() -> int { while true { } }',
    'fn f(a: int) -> int { if a > 0 { return 1; } else { return 2; } }'
  ]

  it.each(PROGRAMS)('accepts %j', (source) => {
    expect(codes(source)).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */
/*  One test per code                                                          */
/* -------------------------------------------------------------------------- */

describe('BCC0008 — name not found', () => {
  it('reports an unknown name, underlining just the name', () => {
    const { message, underlined } = atCode('print nope;', 'BCC0008')
    expect(underlined).toBe('nope')
    expect(message).toBe("cannot find 'nope'")
  })

  it('reports a variable used before it is declared', () => {
    // `let` is deliberately NOT hoisted, unlike a function.
    expect(codes('print x; let x = 1;')).toEqual(['BCC0008'])
  })

  it('does not report a function used before it is declared', () => {
    // Hoisting is what makes declaration order stop mattering for functions,
    // and it is what makes mutual recursion possible at all.
    expect(codes('print f();\nfn f() -> int { return 1; }')).toEqual([])
  })

  it('reports an assignment to a name that does not exist', () => {
    const { underlined } = atCode('nope = 1;', 'BCC0008')
    expect(underlined).toBe('nope')
  })
})

describe('BCC0009 — already declared', () => {
  it('rejects two declarations in one scope', () => {
    const { message, underlined } = atCode('let x = 1; let x = 2;', 'BCC0009')
    expect(underlined).toBe('x')
    expect(message).toBe("'x' is already declared in this scope")
  })

  it('allows shadowing in an inner scope', () => {
    // The useful half of the rule: an inner `x` beside an outer one that still
    // matters is ordinary code.
    expect(codes('let x = 1; { let x = 2; print x; }')).toEqual([])
  })

  it('rejects a parameter colliding with a let in the function body', () => {
    // The body shares the function's scope rather than opening a nested one,
    // which is what a reader expects.
    expect(codes('fn f(a: int) { let a = 1; }')).toEqual(['BCC0009'])
  })

  it('lets the second declaration win, so later uses are not also reported', () => {
    // One mistake, one message. Binding the name to the declaration the reader
    // can see keeps the rest of the block quiet.
    expect(codes('let x = 1; let x = true; print x;')).toEqual(['BCC0009'])
  })
})

describe('BCC0010 — nested function', () => {
  it('rejects a function declared inside a block', () => {
    const { message, underlined } = atCode('fn outer() { fn inner() { } }', 'BCC0010')
    expect(underlined).toBe('inner')
    expect(message).toMatch(/no nested functions/)
  })

  it('still binds the name, so calls to it are not also reported', () => {
    // Refusing to bind would turn one honest error into a "cannot find" at
    // every call — and the second error is the one the user would chase.
    expect(codes('fn outer() { fn inner() -> int { return 1; } print inner(); }')).toEqual([
      'BCC0010'
    ])
  })
})

describe('BCC0011 — unknown type name', () => {
  it('rejects a type nobody defined', () => {
    const { message, underlined } = atCode('let x: Frobnicator = 1;', 'BCC0011')
    expect(underlined).toBe('Frobnicator')
    expect(message).toMatch(/int, bool and unit/)
  })

  it('rejects it on a parameter and on a return type too', () => {
    expect(codes('fn f(a: nope) { }')).toEqual(['BCC0011'])
    expect(codes('fn f() -> nope { }')).toEqual(['BCC0011'])
  })
})

describe('BCC0012 — type mismatch', () => {
  it('rejects an initializer that disagrees with the annotation', () => {
    const { message, underlined } = atCode('let x: int = true;', 'BCC0012')
    expect(underlined).toBe('true')
    expect(message).toBe("'x' is declared int but this is bool")
  })

  it('takes the annotation as the truth, so later uses stay quiet', () => {
    // The user said what they meant. Believing the initializer instead would
    // report a second error at every use of `x`.
    expect(codes('let x: int = true; print x + 1;')).toEqual(['BCC0012'])
    expect(typeOfLet('let x: int = true;', 'x')).toEqual({ kind: 'int' })
  })

  it('rejects an assignment of the wrong type', () => {
    const { message, underlined } = atCode('let x = 1; x = true;', 'BCC0012')
    expect(underlined).toBe('true')
    expect(message).toBe("'x' is int but this is bool")
  })

  it('rejects a non-bool condition', () => {
    expect(atCode('if 1 { }', 'BCC0012').message).toMatch(/if condition must be a bool/)
    expect(atCode('while 1 { }', 'BCC0012').message).toMatch(/while condition must be a bool/)
  })

  it('rejects an argument of the wrong type, underlining the argument', () => {
    const source = 'fn f(a: int) { }\nf(true);'
    const { message, underlined } = atCode(source, 'BCC0012')
    expect(underlined).toBe('true')
    expect(message).toBe('argument 1 should be int, but this is bool')
  })

  it('names WHICH argument, so a long call is not a guessing game', () => {
    const source = 'fn f(a: int, b: int, c: int) { }\nf(1, 2, true);'
    expect(atCode(source, 'BCC0012').message).toMatch(/argument 3/)
  })

  it('rejects a returned value of the wrong type', () => {
    const { message, underlined } = atCode('fn f() -> int { return true; }', 'BCC0012')
    expect(underlined).toBe('true')
    expect(message).toBe('this function returns int, but this is bool')
  })

  it('rejects a bare return from a function that promises a value', () => {
    expect(atCode('fn f() -> int { return; }', 'BCC0012').message).toMatch(/return needs a value/)
  })

  it('rejects printing something with no value', () => {
    const source = 'fn f() { }\nprint f();'
    const { message, underlined } = atCode(source, 'BCC0012')
    expect(underlined).toBe('f()')
    expect(message).toBe('print needs an int or a bool, but this is unit')
  })
})

describe('BCC0013 — operator cannot be applied', () => {
  it('rejects arithmetic on a bool, underlining the operator', () => {
    // The operator, not the whole expression: the `+` is what is wrong.
    const { message, underlined } = atCode('print true + 1;', 'BCC0013')
    expect(underlined).toBe('+')
    expect(message).toBe("'+' needs int operands, but found bool and int")
  })

  it('rejects comparison on bools', () => {
    expect(atCode('print true < false;', 'BCC0013').underlined).toBe('<')
  })

  it('rejects equality between different types', () => {
    const { message, underlined } = atCode('print 1 == true;', 'BCC0013')
    expect(underlined).toBe('==')
    expect(message).toBe("'==' cannot compare int with bool")
  })

  it('rejects comparing functions, naming the real reason', () => {
    // Two BCC0019s rather than one BCC0013. "functions are not values" is what
    // is actually wrong here; "cannot compare unit with unit" would have been a
    // true sentence about a program nobody wrote.
    expect(codes('fn f() { }\nfn g() { }\nprint f == g;')).toEqual(['BCC0019', 'BCC0019'])
  })

  it('rejects && on non-bools, underlining the operand that is wrong', () => {
    // The operand, not the operator: with `&&` it is one SIDE that is wrong,
    // and pointing at the operator would leave the user checking both.
    const { message, underlined } = atCode('print 1 && true;', 'BCC0013')
    expect(underlined).toBe('1')
    expect(message).toBe("'&&' needs bool operands, but this one is int")
  })

  it('rejects negating a bool and not-ing an int', () => {
    expect(atCode('print -true;', 'BCC0013').underlined).toBe('-')
    expect(atCode('print !1;', 'BCC0013').underlined).toBe('!')
  })
})

describe('BCC0014 — not a function', () => {
  it('rejects calling a variable', () => {
    const { message, underlined } = atCode('let x = 1; x();', 'BCC0014')
    expect(underlined).toBe('x')
    expect(message).toBe('this is a int, not a function, so it cannot be called')
  })

  it('rejects calling the result of a call', () => {
    // `f()()` parses — the parser deals in shape. This is where it is rejected,
    // with a message that says why.
    expect(codes('fn f() -> int { return 1; }\nf()();')).toEqual(['BCC0014'])
  })
})

describe('BCC0015 — wrong number of arguments', () => {
  it('rejects too few', () => {
    const { message } = atCode('fn f(a: int, b: int) { }\nf(1);', 'BCC0015')
    expect(message).toBe('expected 2 arguments, found 1')
  })

  it('rejects too many', () => {
    expect(atCode('fn f() { }\nf(1);', 'BCC0015').message).toBe('expected 0 arguments, found 1')
  })

  it('gets the plural right for exactly one', () => {
    expect(atCode('fn f(a: int) { }\nf();', 'BCC0015').message).toBe(
      'expected 1 argument, found 0'
    )
  })

  it('still knows the result type, so the surrounding expression is checked', () => {
    // Giving up here would hide a second, unrelated mistake on the same line.
    expect(codes('fn f(a: int) -> int { return 1; }\nprint f() + true;')).toEqual([
      'BCC0015',
      'BCC0013'
    ])
  })
})

describe('BCC0016 — not all paths return', () => {
  it('rejects a function that can fall off the end', () => {
    const { message, underlined } = atCode('fn f() -> int { print 1; }', 'BCC0016')
    expect(underlined).toBe('f')
    expect(message).toBe("'f' returns int, but it can finish without returning")
  })

  it('rejects an if with no else', () => {
    // The condition may be false, so this path reaches the end.
    expect(codes('fn f(a: int) -> int { if a > 0 { return 1; } }')).toEqual(['BCC0016'])
  })

  it('accepts an if whose every branch returns', () => {
    expect(codes('fn f(a: int) -> int { if a > 0 { return 1; } else { return 2; } }')).toEqual([])
  })

  it('accepts an else-if chain that ends in an else', () => {
    expect(
      codes('fn f(a: int) -> int { if a > 0 { return 1; } else if a < 0 { return 2; } else { return 3; } }')
    ).toEqual([])
  })

  it('rejects a loop that might not run', () => {
    expect(codes('fn f(a: int) -> int { while a > 0 { return 1; } }')).toEqual(['BCC0016'])
  })

  it('accepts while true, because BCC has no break', () => {
    // The classic false positive, and it is avoidable here rather than merely
    // tolerated: with no `break` in the language, `while true` provably never
    // exits normally.
    expect(codes('fn f() -> int { while true { } }')).toEqual([])
  })

  it('says nothing about a function that returns unit', () => {
    expect(codes('fn f() { print 1; }')).toEqual([])
    expect(codes('fn f() -> unit { print 1; }')).toEqual([])
  })
})

describe('BCC0017 — return outside a function', () => {
  it('rejects a top-level return', () => {
    const { message, underlined } = atCode('return 1;', 'BCC0017')
    expect(underlined).toBe('return 1;')
    expect(message).toBe('return is only allowed inside a function')
  })

  it('rejects a return in a bare block', () => {
    expect(codes('{ return; }')).toEqual(['BCC0017'])
  })
})

describe('BCC0019 — functions are not values', () => {
  it('rejects binding a function to a variable', () => {
    // Without this rule the language grows first-class functions by accident:
    // `g` would have a function type, `g()` would type-check, and lowering
    // would need an indirect call the VM has no way to make.
    const { message, underlined } = atCode('fn f() { }\nlet g = f;', 'BCC0019')
    expect(underlined).toBe('f')
    expect(message).toMatch(/no function values/)
  })

  it('rejects passing a function as an argument', () => {
    expect(codes('fn f() { }\nfn g(a: int) { }\ng(f);')).toEqual(['BCC0019'])
  })

  it('allows the one position where naming a function is the point', () => {
    expect(codes('fn f() -> int { return 1; }\nprint f();')).toEqual([])
  })

  it('still reports a call on something genuinely not callable', () => {
    // `f()()` — the inner call returns an int, so BCC0014 and not BCC0019.
    expect(codes('fn f() -> int { return 1; }\nf()();')).toEqual(['BCC0014'])
  })
})

describe('BCC0018 — cannot assign to a function', () => {
  it('rejects assigning over a function name', () => {
    const { message, underlined } = atCode('fn f() { }\nf = 1;', 'BCC0018')
    expect(underlined).toBe('f')
    expect(message).toBe("'f' is a function and cannot be assigned to")
  })
})

/* -------------------------------------------------------------------------- */
/*  One mistake, one message                                                   */
/* -------------------------------------------------------------------------- */

describe('the error type stops one mistake becoming five', () => {
  it('reports each use of an unknown name, and no type errors on top', () => {
    // Four uses, four "cannot find" messages — the same thing tsc does, and the
    // right thing: each one is a name the user has to fix, and squiggling only
    // the first would hide the rest.
    //
    // What the poison type buys is the ABSENCE of the other three. Every one of
    // `+`, `*` and `-` has an operand it could not type, and without `error`
    // being compatible with everything each would add its own "cannot be
    // applied to unknown" on top — seven messages for one typo.
    expect(codes('print nope + nope * nope - nope;')).toEqual([
      'BCC0008',
      'BCC0008',
      'BCC0008',
      'BCC0008'
    ])
  })

  it('does not re-report a value it already complained about', () => {
    expect(codes('let x: int = true; print x + 1; print x * 2;')).toEqual(['BCC0012'])
  })

  it('stays quiet about a call whose callee does not exist', () => {
    expect(codes('nope(1, 2, 3);')).toEqual(['BCC0008'])
  })

  it('reports two independent mistakes as two', () => {
    // Poisoning must not swallow a genuinely separate error.
    expect(codes('print nope; print true + 1;')).toEqual(['BCC0008', 'BCC0013'])
  })
})

describe('a file with a syntax error still gets sensible types', () => {
  it('does not pile type errors on top of a parse error', () => {
    // The hole a broken expression leaves is typed as `error`, so the checker
    // says nothing about it. The editor still gets symbol and type information
    // for the rest of the file, which is the point of typing a broken file at
    // all.
    expect(codes('let x = ;')).toEqual(['BCC0004'])
    expect(codes('let x = 1\nprint x;')).toEqual(['BCC0003'])
  })

  it('still resolves and types the parts that are intact', () => {
    const source = 'let x = 1;\nlet y = ;\nprint x + 1;'
    expect(codes(source)).toEqual(['BCC0004'])
    expect(typeOfLet(source, 'x')).toEqual({ kind: 'int' })
  })
})

/* -------------------------------------------------------------------------- */
/*  Inference, scopes and the type language itself                             */
/* -------------------------------------------------------------------------- */

describe('inference', () => {
  it('takes an unannotated let from its initializer', () => {
    expect(typeOfLet('let x = 1 + 2;', 'x')).toEqual({ kind: 'int' })
    expect(typeOfLet('let x = 1 < 2;', 'x')).toEqual({ kind: 'bool' })
  })

  it('gives a parameter the type its annotation says', () => {
    expect(typeOfLet('fn f(a: bool) { }', 'a')).toEqual({ kind: 'bool' })
  })

  it('gives a function its signature', () => {
    expect(typeOfLet('fn f(a: int, b: bool) -> int { return a; }', 'f')).toEqual({
      kind: 'function',
      params: [{ kind: 'int' }, { kind: 'bool' }],
      result: { kind: 'int' }
    })
  })

  it('defaults a missing return type to unit rather than to an error', () => {
    expect(typeOfLet('fn f() { }', 'f')).toEqual({
      kind: 'function',
      params: [],
      result: { kind: 'unit' }
    })
  })
})

describe('the scope tree', () => {
  it('nests a block inside a function inside the global scope', () => {
    const { program } = parseSource('fn f(a: int) { { let b = 1; } }')
    const { scope } = resolve(program)

    expect(scope.kind).toBe('global')
    expect(scope.symbols.map((symbol) => symbol.name)).toEqual(['f'])

    const fn = scope.children[0]
    expect(fn?.kind).toBe('function')
    expect(fn?.symbols.map((symbol) => symbol.name)).toEqual(['a'])

    const block = fn?.children[0]
    expect(block?.kind).toBe('block')
    expect(block?.symbols.map((symbol) => symbol.name)).toEqual(['b'])
  })

  it('records what each name refers to', () => {
    const { program } = parseSource('let x = 1; print x;')
    const { uses, declarations } = resolve(program)

    const declared = [...declarations.values()]
    const used = [...uses.values()]
    expect(used).toHaveLength(1)
    // The same symbol object, so a rename or a go-to-definition is a lookup.
    expect(used[0]).toBe(declared[0])
  })

  it('separates a store from a load of the same name', () => {
    const { program } = parseSource('let x = 1; x = x + 1;')
    const { uses, stores } = resolve(program)

    expect([...stores.keys()].map((ident) => ident.text)).toEqual(['x'])
    expect([...uses.keys()].map((name) => name.text)).toEqual(['x'])
    // Same symbol, different roles — the def/use split Part 5 lowers on.
    expect([...stores.values()][0]).toBe([...uses.values()][0])
  })
})

describe('the type language', () => {
  it('describes every type the way a message would', () => {
    expect(describeType({ kind: 'int' })).toBe('int')
    expect(describeType({ kind: 'bool' })).toBe('bool')
    expect(describeType({ kind: 'unit' })).toBe('unit')
    expect(describeType({ kind: 'error' })).toBe('unknown')
    expect(
      describeType({
        kind: 'function',
        params: [{ kind: 'int' }, { kind: 'bool' }],
        result: { kind: 'unit' }
      })
    ).toBe('(int, bool) -> unit')
  })

  it('compares function types structurally', () => {
    const f: Type = { kind: 'function', params: [{ kind: 'int' }], result: { kind: 'int' } }
    const same: Type = { kind: 'function', params: [{ kind: 'int' }], result: { kind: 'int' } }
    const different: Type = { kind: 'function', params: [{ kind: 'bool' }], result: { kind: 'int' } }

    expect(sameType(f, same)).toBe(true)
    expect(sameType(f, different)).toBe(false)
    expect(sameType(f, { kind: 'int' })).toBe(false)
  })
})

describe('diagnostic codes', () => {
  it('emits only codes it has declared, with a message and a span', () => {
    const declared = new Set(Object.keys(DIAGNOSTIC_TITLES))
    const sources = [
      'print nope;',
      'let x = 1; let x = 2;',
      'fn a() { fn b() { } }',
      'let x: Nope = 1;',
      'let x: int = true;',
      'print true + 1;',
      'let x = 1; x();',
      'fn f() { }\nf(1);',
      'fn f() -> int { }',
      'return 1;',
      'fn f() { }\nf = 1;',
      'fn f() { }\nlet g = f;'
    ]

    for (const source of sources) {
      const found = checkAll(source)
      expect(found.length, source).toBeGreaterThan(0)
      for (const diagnostic of found) {
        expect(declared.has(diagnostic.code), `undeclared: ${diagnostic.code}`).toBe(true)
        expect(diagnostic.message.length, source).toBeGreaterThan(0)
        expect(diagnostic.span.offset, source).toBeGreaterThanOrEqual(0)
        expect(
          diagnostic.span.offset + diagnostic.span.length,
          source
        ).toBeLessThanOrEqual(source.length)
      }
    }
  })

  it('covers every code the two passes can raise', () => {
    // The resolver and the checker between them own BCC0008 to BCC0019. If a
    // code is added without a test above, this fails and names it.
    const owned: DiagnosticCode[] = [
      'BCC0008',
      'BCC0009',
      'BCC0010',
      'BCC0011',
      'BCC0012',
      'BCC0013',
      'BCC0014',
      'BCC0015',
      'BCC0016',
      'BCC0017',
      'BCC0018',
      'BCC0019'
    ]
    const exercised = new Set(
      [
        'print nope;',
        'let x = 1; let x = 2;',
        'fn a() { fn b() { } }',
        'let x: Nope = 1;',
        'let x: int = true;',
        'print true + 1;',
        'let x = 1; x();',
        'fn f() { }\nf(1);',
        'fn f() -> int { }',
        'return 1;',
        'fn f() { }\nf = 1;',
      'fn f() { }\nlet g = f;'
      ].flatMap(codes)
    )

    for (const code of owned) {
      expect(exercised.has(code), `${code} (${DIAGNOSTIC_TITLES[code]}) is never raised`).toBe(true)
    }
  })
})
