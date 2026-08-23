import { describe, expect, it } from 'vitest'
import { tokenize } from '../../src/lang/lexer'
import { isTrivia, type Token, type TokenKind } from '../../src/lang/token'

/**
 * The lexer, and mostly its spans.
 *
 * A wrong token kind is loud — the parser fails immediately and the test that
 * caught it names the construct. A wrong SPAN is silent: everything compiles,
 * everything runs, and a highlight lands two lines off five stages downstream
 * with nothing pointing back here. So the property tests below carry more weight
 * than the per-construct ones.
 */

const kinds = (source: string): TokenKind[] =>
  tokenize(source)
    .filter((token) => !isTrivia(token.kind) && token.kind !== 'eof')
    .map((token) => token.kind)

const texts = (source: string): string[] =>
  tokenize(source)
    .filter((token) => !isTrivia(token.kind) && token.kind !== 'eof')
    .map((token) => token.text)

/** A spread of inputs: real code, broken code, and things that are not code. */
const CORPUS: readonly string[] = [
  '',
  ' ',
  '\n',
  '\r\n',
  '\n\n\n',
  'let x = 1;',
  'let x: int = 1 + 2 * 3;',
  'fn add(a: int, b: int) -> int { return a + b; }',
  'if x < 10 && y >= 2 { print x; } else { print y; }',
  'while i != 0 { i = i - 1; }',
  'let ok = true; let no = false;',
  '// just a comment',
  '// comment\nlet x = 1;',
  '/* block */ let x = 1;',
  '/* unterminated',
  'let x = 1; // trailing\r\nlet y = 2;',
  'letter let letting',
  '@@@',
  'let x = @ 1;',
  'a\r\nb\rc\nd',
  '1234567890',
  'x==y!=z<=w>=v',
  '((((()))))',
  'The quick brown fox, jumped over 42 lazy dogs!',
  '\t\t  \n  \t',
  'fn f() -> int { return 1 }\nfn g() -> int { return 2 }'
]

describe('tokenize — the tiling property', () => {
  /**
   * The strongest single assertion in this file.
   *
   * If the concatenated token texts rebuild the input, then no code unit was
   * dropped, none was emitted twice, and the tokens are in source order. Nearly
   * every span bug violates one of those three.
   */
  it('rebuilds the input exactly, for every input', () => {
    for (const source of CORPUS) {
      const rebuilt = tokenize(source)
        .map((token) => token.text)
        .join('')

      expect(rebuilt, `failed to rebuild: ${JSON.stringify(source)}`).toBe(source)
    }
  })

  it('emits spans that are contiguous and start at zero', () => {
    for (const source of CORPUS) {
      const tokens = tokenize(source)

      let expectedOffset = 0
      for (const token of tokens) {
        expect(token.span.offset, `gap or overlap in ${JSON.stringify(source)}`).toBe(expectedOffset)
        expect(token.span.length).toBe(token.text.length)
        expectedOffset += token.span.length
      }
      expect(expectedOffset).toBe(source.length)
    }
  })

  it('ends with a zero-width eof at the end of the input', () => {
    for (const source of CORPUS) {
      const tokens = tokenize(source)
      const last = tokens[tokens.length - 1]

      expect(last?.kind).toBe('eof')
      expect(last?.text).toBe('')
      expect(last?.span.offset).toBe(source.length)
      expect(last?.span.length).toBe(0)
      // A zero-width span still has a position, so a diagnostic reported at
      // end-of-file has somewhere to draw.
      expect(last?.span.startLine).toBe(last?.span.endLine)
      expect(last?.span.startColumn).toBe(last?.span.endColumn)
    }
  })

  /**
   * Positions recomputed from the offset, independently of the scanner's
   * incremental bookkeeping.
   *
   * This does re-state the CRLF rule rather than deriving it from somewhere
   * else, so it is not a fully independent oracle. What it does catch is the
   * bug class that actually happens: the incremental line/column drifting out
   * of step with the offset as the scan proceeds.
   */
  it('reports line and column consistent with the offset', () => {
    for (const source of CORPUS) {
      for (const token of tokenize(source)) {
        const { line, column } = positionOf(source, token.span.offset)

        expect(token.span.startLine, `line at offset ${token.span.offset} of ${JSON.stringify(source)}`).toBe(line)
        expect(token.span.startColumn, `column at offset ${token.span.offset} of ${JSON.stringify(source)}`).toBe(column)
      }
    }
  })
})

/** 1-based line and column at `target`, counting `\r\n` as one break. */
function positionOf(source: string, target: number): { line: number; column: number } {
  let line = 1
  let column = 1

  for (let i = 0; i < target; i++) {
    const ch = source[i]
    if (ch === '\n') {
      line++
      column = 1
    } else if (ch === '\r') {
      if (source[i + 1] !== '\n') {
        line++
        column = 1
      }
    } else {
      column++
    }
  }

  return { line, column }
}

describe('tokenize — never throws', () => {
  /**
   * Seeded rather than `Math.random`, so a failure is reproducible from the
   * message rather than being a run that once went wrong.
   */
  it('survives arbitrary input', () => {
    const alphabet = ' \t\n\r{}()<>=!&|+-*/%,;:@#$~`"\'\\abcXY_019./*'
    let seed = 0x5eed

    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed
    }

    for (let run = 0; run < 400; run++) {
      let source = ''
      const length = next() % 60
      for (let i = 0; i < length; i++) {
        source += alphabet[next() % alphabet.length]
      }

      expect(() => tokenize(source), `threw on: ${JSON.stringify(source)}`).not.toThrow()
      expect(
        tokenize(source)
          .map((token) => token.text)
          .join(''),
        `did not rebuild: ${JSON.stringify(source)}`
      ).toBe(source)
    }
  })
})

describe('tokenize — keywords and identifiers', () => {
  it('recognises every keyword', () => {
    expect(kinds('let if else while fn return print true false')).toEqual([
      'let',
      'if',
      'else',
      'while',
      'fn',
      'return',
      'print',
      'true',
      'false'
    ])
  })

  it('matches whole words only', () => {
    // The classic prefix bug: `letter` must not lex as `let` + `ter`.
    expect(kinds('letter')).toEqual(['identifier'])
    expect(kinds('iffy')).toEqual(['identifier'])
    expect(kinds('printer')).toEqual(['identifier'])
    expect(texts('letter')).toEqual(['letter'])
  })

  it('allows underscores and digits inside identifiers', () => {
    expect(texts('_x x_1 a1b2')).toEqual(['_x', 'x_1', 'a1b2'])
  })

  it('does not start an identifier with a digit', () => {
    // `1abc` is a number followed by a name, which the parser rejects — the
    // lexer's job is only to say what is there.
    expect(kinds('1abc')).toEqual(['int', 'identifier'])
    expect(texts('1abc')).toEqual(['1', 'abc'])
  })
})

describe('tokenize — operators', () => {
  it('prefers the two-character operator', () => {
    expect(kinds('==')).toEqual(['equals'])
    expect(kinds('!=')).toEqual(['notEquals'])
    expect(kinds('<=')).toEqual(['lessEqual'])
    expect(kinds('>=')).toEqual(['greaterEqual'])
    expect(kinds('&&')).toEqual(['and'])
    expect(kinds('||')).toEqual(['or'])
    expect(kinds('->')).toEqual(['arrow'])
  })

  it('still lexes the one-character forms', () => {
    expect(kinds('= ! < > + - * / %')).toEqual([
      'assign',
      'not',
      'less',
      'greater',
      'plus',
      'minus',
      'star',
      'slash',
      'percent'
    ])
  })

  it('does not merge across a space', () => {
    expect(kinds('= =')).toEqual(['assign', 'assign'])
    expect(kinds('- >')).toEqual(['minus', 'greater'])
  })
})

describe('tokenize — trivia', () => {
  it('runs a line comment to the end of the line, not past it', () => {
    const tokens = tokenize('// hi\nlet')
    const comment = tokens.find((token) => token.kind === 'comment')

    expect(comment?.text).toBe('// hi')
    expect(kinds('// hi\nlet')).toEqual(['let'])
  })

  it('handles a block comment', () => {
    expect(kinds('let /* mid */ x')).toEqual(['let', 'identifier'])
  })

  it('reports an unterminated block comment as an error covering the rest', () => {
    const tokens = tokenize('let /* oops')
    const error = tokens.find((token) => token.kind === 'error')

    // Consumed to end of file, which is what the author meant, but reported as
    // an error so the parser can say something useful.
    expect(error?.text).toBe('/* oops')
    expect(tokens.map((token) => token.text).join('')).toBe('let /* oops')
  })

  it('groups whitespace into one token', () => {
    const tokens = tokenize('a   \n\t b')
    expect(tokens.filter((token) => token.kind === 'whitespace')).toHaveLength(1)
  })
})

describe('tokenize — errors', () => {
  it('groups a run of unrecognised characters into one token', () => {
    // One diagnostic for a pasted paragraph, not one per character.
    const tokens = tokenize('@@@')
    const errors = tokens.filter((token) => token.kind === 'error')

    expect(errors).toHaveLength(1)
    expect(errors[0]?.text).toBe('@@@')
  })

  it('stops an error run at the next real token', () => {
    expect(kinds('@@@let')).toEqual(['error', 'let'])
    expect(texts('@@@let')).toEqual(['@@@', 'let'])
  })

  it('keeps scanning after an error', () => {
    // The point of not throwing: one bad character costs one token.
    expect(kinds('let x = @ 1;')).toEqual([
      'let',
      'identifier',
      'assign',
      'error',
      'int',
      'semicolon'
    ])
  })
})

describe('tokenize — line endings', () => {
  it('counts CRLF as one line break', () => {
    const tokens = tokenize('a\r\nb')
    const b = tokens.find((token) => token.text === 'b')

    // Counting the CR and the LF separately would put `b` on line 3.
    expect(b?.span.startLine).toBe(2)
    expect(b?.span.startColumn).toBe(1)
  })

  it('counts a lone CR as a line break', () => {
    const tokens = tokenize('a\rb')
    expect(tokens.find((token) => token.text === 'b')?.span.startLine).toBe(2)
  })

  it('tracks columns across mixed endings', () => {
    const tokens = tokenize('a\r\nbb\rccc\nd')
    const find = (text: string): Token | undefined => tokens.find((token) => token.text === text)

    expect(find('bb')?.span.startLine).toBe(2)
    expect(find('ccc')?.span.startLine).toBe(3)
    expect(find('d')?.span.startLine).toBe(4)
  })
})

describe('tokenize — a whole function', () => {
  it('lexes the shape Part 2 has to parse', () => {
    expect(kinds('fn add(a: int, b: int) -> int { return a + b; }')).toEqual([
      'fn',
      'identifier',
      'leftParen',
      'identifier',
      'colon',
      'identifier',
      'comma',
      'identifier',
      'colon',
      'identifier',
      'rightParen',
      'arrow',
      'identifier',
      'leftBrace',
      'return',
      'identifier',
      'plus',
      'identifier',
      'semicolon',
      'rightBrace'
    ])
  })
})
