import { describe, expect, it } from 'vitest'
import { parseSource } from '../../src/lang/parser'
import { resolve } from '../../src/lang/symbols'
import { typeCheck } from '../../src/lang/type-check'
import {
  definitionAt,
  documentSymbols,
  hoverAt,
  identifierAt,
  referencesAt,
  rejectNewName,
  renameAt,
  symbolAt,
  type OutlineNode
} from '../../src/lang/navigation'

/**
 * Navigation, which is the whole justification for Workstream A.
 *
 * Two properties carry the file. Offsets must resolve to the identifier a user
 * would say they clicked on — including the caret sitting just past the end of
 * a word, which is where it lands after double-clicking. And references must
 * follow SYMBOL IDENTITY, so a shadowed name is a different symbol and a rename
 * of the inner one leaves the outer one alone.
 *
 * Every assertion is written as source text rather than as offsets. A span
 * expectation reading `['x', 'x']` can be checked by eye against the fixture;
 * one reading `[{ offset: 23, length: 1 }]` cannot, and a wrong span is exactly
 * the bug that survives a passing test.
 */

function front(source: string) {
  const { program } = parseSource(source)
  const resolution = resolve(program)
  const types = typeCheck(program, resolution)
  return { program, resolution, types }
}

/** The offset of the `nth` occurrence of `needle`, 0-based. */
function at(source: string, needle: string, nth = 0): number {
  let index = -1
  for (let seen = 0; seen <= nth; seen++) {
    index = source.indexOf(needle, index + 1)
    if (index < 0) throw new Error(`no occurrence ${nth} of ${needle}`)
  }
  return index
}

const slice = (source: string, span: { offset: number; length: number }): string =>
  source.slice(span.offset, span.offset + span.length)

describe('identifierAt', () => {
  const source = 'let total = 1;\nprint total;\n'

  it('finds the identifier the caret is inside', () => {
    const { program } = front(source)
    expect(identifierAt(program, at(source, 'total') + 2)?.text).toBe('total')
  })

  it('finds the identifier the caret sits immediately after', () => {
    // Where the caret lands after a double-click, and where F12 most often
    // gets pressed. An exclusive end here would make go-to-definition fail
    // exactly when the user has just selected the word they want.
    const { program } = front(source)
    const end = at(source, 'total') + 'total'.length
    expect(identifierAt(program, end)?.text).toBe('total')
  })

  it('is null on whitespace and on punctuation', () => {
    const { program } = front(source)
    expect(identifierAt(program, at(source, ';'))).toBeNull()
  })

  it('is null on a keyword', () => {
    const { program } = front(source)
    expect(identifierAt(program, at(source, 'print'))).toBeNull()
  })
})

describe('definitionAt', () => {
  it('resolves a read to its declaration', () => {
    const source = 'let total = 1;\nprint total;\n'
    const { program, resolution } = front(source)
    const span = definitionAt(program, resolution, at(source, 'total', 1))
    expect(span).not.toBeNull()
    expect(span?.startLine).toBe(1)
    expect(span?.startColumn).toBe(5)
  })

  it('resolves a call to the function it calls', () => {
    const source = 'fn twice(n: int) -> int {\n  return n * 2;\n}\nprint twice(3);\n'
    const { program, resolution } = front(source)
    const span = definitionAt(program, resolution, at(source, 'twice', 1))
    expect(span?.startLine).toBe(1)
    expect(slice(source, span!)).toBe('twice')
  })

  it('resolves a parameter read to the parameter', () => {
    const source = 'fn twice(value: int) -> int {\n  return value * 2;\n}\n'
    const { program, resolution } = front(source)
    const span = definitionAt(program, resolution, at(source, 'value', 1))
    expect(span?.startLine).toBe(1)
    expect(span?.startColumn).toBe(10)
  })

  it('is null for a name the resolver rejected', () => {
    // "cannot find 'nope'" and "F12 does nothing" are the same fact. The
    // resolver never records a use it could not resolve, so this needs no
    // special case here — which is the assertion.
    const source = 'print nope;\n'
    const { program, resolution } = front(source)
    expect(definitionAt(program, resolution, at(source, 'nope'))).toBeNull()
  })

  it('is null on a keyword', () => {
    const source = 'let x = 1;\n'
    const { program, resolution } = front(source)
    expect(definitionAt(program, resolution, at(source, 'let'))).toBeNull()
  })
})

describe('referencesAt', () => {
  const source = 'let count = 0;\ncount = count + 1;\nprint count;\n'

  it('finds reads, writes and the declaration, in source order', () => {
    const { program, resolution } = front(source)
    const spans = referencesAt(program, resolution, at(source, 'count'), true)
    expect(spans.map((span) => span.startLine)).toEqual([1, 2, 2, 3])
    expect(spans.map((span) => slice(source, span))).toEqual(['count', 'count', 'count', 'count'])
  })

  it('omits the declaration when asked to', () => {
    const { program, resolution } = front(source)
    const spans = referencesAt(program, resolution, at(source, 'count'), false)
    expect(spans.map((span) => span.startLine)).toEqual([2, 2, 3])
  })

  /**
   * The property that makes this more correct than a text search, and the one
   * Monaco's worker cannot give us here.
   */
  it('does not cross a shadowing boundary', () => {
    const shadowed = 'let x = 1;\nif true {\n  let x = 2;\n  print x;\n}\nprint x;\n'
    const { program, resolution } = front(shadowed)

    const inner = referencesAt(program, resolution, at(shadowed, 'x', 1), true)
    expect(inner.map((span) => span.startLine)).toEqual([3, 4])

    const outer = referencesAt(program, resolution, at(shadowed, 'x'), true)
    expect(outer.map((span) => span.startLine)).toEqual([1, 6])
  })

  it('does not confuse two parameters that share a name', () => {
    const twoFns =
      'fn a(arg: int) -> int {\n  return arg;\n}\nfn b(arg: int) -> int {\n  return arg;\n}\n'
    const { program, resolution } = front(twoFns)
    const spans = referencesAt(program, resolution, at(twoFns, 'arg', 2), true)
    expect(spans.map((span) => span.startLine)).toEqual([4, 5])
  })

  it('is empty on an unresolvable name', () => {
    const { program, resolution } = front('print nope;\n')
    expect(referencesAt(program, resolution, 6, true)).toEqual([])
  })
})

describe('renameAt', () => {
  const source = 'let count = 0;\ncount = count + 1;\n'

  it('plans every occurrence, declaration included', () => {
    const { program, resolution } = front(source)
    const plan = renameAt(program, resolution, at(source, 'count', 2))
    expect(plan?.placeholder).toBe('count')
    expect(plan?.spans).toHaveLength(3)
    expect(slice(source, plan!.target)).toBe('count')
  })

  it('is null where there is nothing to rename', () => {
    const { program, resolution } = front(source)
    expect(renameAt(program, resolution, at(source, '='))).toBeNull()
  })
})

describe('rejectNewName', () => {
  // Validated by running the lexer over the candidate rather than by a regular
  // expression, so the rule cannot drift from the language.
  it('accepts an ordinary identifier', () => {
    expect(rejectNewName('total2')).toBeNull()
    expect(rejectNewName('_private')).toBeNull()
  })

  it('rejects a keyword', () => {
    expect(rejectNewName('while')).toContain('keyword')
  })

  it('rejects a number, a space and an operator', () => {
    expect(rejectNewName('2x')).not.toBeNull()
    expect(rejectNewName('two words')).not.toBeNull()
    expect(rejectNewName('a+b')).not.toBeNull()
    expect(rejectNewName('')).not.toBeNull()
  })
})

describe('documentSymbols', () => {
  const source =
    'let top = 1;\nfn add(a: int, b: int) -> int {\n  let sum = a + b;\n  return sum;\n}\nfn noop() {\n}\n'

  const outline = (): OutlineNode[] => {
    const { program, resolution, types } = front(source)
    return documentSymbols(program, resolution, types)
  }

  it('lists top-level declarations with their signatures', () => {
    const rows = outline()
    expect(rows.map((row) => `${row.kind} ${row.name}${row.detail}`)).toEqual([
      'variable top: int',
      'function add(a: int, b: int) -> int',
      'function noop() -> unit'
    ])
  })

  it('nests a function body local under its function', () => {
    const add = outline()[1]
    expect(add?.children.map((child) => child.name)).toEqual(['sum'])
  })

  it('separates the row range from the name range', () => {
    // The row highlights the whole declaration; clicking it puts the cursor on
    // the name. Collapsing the two makes the outline select an entire function
    // when all the user wanted was to go to it.
    const add = outline()[1]
    expect(slice(source, add!.selection)).toBe('add')
    expect(slice(source, add!.span).startsWith('fn add')).toBe(true)
    expect(add!.span.length).toBeGreaterThan(add!.selection.length)
  })

  it('surfaces a let declared inside a block', () => {
    const nested = 'fn f() {\n  while true {\n    let inner = 1;\n  }\n}\n'
    const { program, resolution, types } = front(nested)
    const rows = documentSymbols(program, resolution, types)
    expect(rows[0]?.children.map((child) => child.name)).toEqual(['inner'])
  })
})

describe('hoverAt', () => {
  const source = 'fn add(a: int, b: int) -> int {\n  return a + b;\n}\nlet ok = true;\n'

  it('describes a function by its signature', () => {
    const { program, resolution, types } = front(source)
    expect(hoverAt(program, resolution, types, at(source, 'add'))?.text).toBe(
      'fn add(a: int, b: int) -> int'
    )
  })

  it('describes a parameter and a variable by their type', () => {
    const { program, resolution, types } = front(source)
    expect(hoverAt(program, resolution, types, at(source, 'a', 1))?.text).toBe('parameter a: int')
    expect(hoverAt(program, resolution, types, at(source, 'ok'))?.text).toBe('let ok: bool')
  })

  it('falls back to the type of the expression under the pointer', () => {
    // Hovering the `+` is not hovering an identifier, and answering `int`
    // anyway is what makes hover feel like it read the file.
    const { program, resolution, types } = front(source)
    const hover = hoverAt(program, resolution, types, at(source, '+'))
    expect(hover?.text).toBe('int')
    expect(slice(source, hover!.span)).toBe('a + b')
  })

  it('is null over trivia', () => {
    const { program, resolution, types } = front(source)
    expect(hoverAt(program, resolution, types, source.indexOf('\n'))).toBeNull()
  })
})

describe('symbolAt', () => {
  it('answers from a store site as well as from a read', () => {
    const source = 'let x = 1;\nx = 2;\n'
    const { program, resolution } = front(source)
    expect(symbolAt(program, resolution, at(source, 'x', 1))?.symbol.kind).toBe('variable')
  })
})
