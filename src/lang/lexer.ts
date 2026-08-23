import { KEYWORDS, type Span, type Token, type TokenKind } from './token'

/**
 * The BCC lexer.
 *
 * Two guarantees, both load-bearing for a compiler that lives inside an editor
 * rather than one that runs in a batch:
 *
 * **It never throws.** The input is broken on most keystrokes — half-typed
 * identifiers, an unclosed comment, a stray character from a paste. Anything
 * unrecognised becomes an `error` token and scanning continues, so one bad
 * character costs one token rather than the whole file.
 *
 * **Its output tiles the source exactly.** Every code unit of the input belongs
 * to exactly one token, trivia included, in source order. So
 * `tokens.map((t) => t.text).join('') === source` — one property that catches
 * almost every span bug, and span bugs are the ones that surface five stages
 * later as a highlight landing on the wrong line.
 */

const EOF_CHAR = ''

/** Digits only. BCC has no floats, no hex and no separators. */
function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9'
}

function isIdentifierStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_'
}

function isIdentifierPart(ch: string): boolean {
  return isIdentifierStart(ch) || isDigit(ch)
}

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v'
}

/**
 * Scans `source` into tokens.
 *
 * Single pass, no backtracking. Line and column are carried along as the scan
 * moves rather than recomputed per token: deriving a position from an offset
 * means counting newlines from the start of the file, and doing that once per
 * token is quadratic on exactly the large files where it would be noticed.
 */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = []

  let offset = 0
  let line = 1
  let column = 1

  const peek = (ahead = 0): string => source[offset + ahead] ?? EOF_CHAR

  /**
   * Consumes `count` code units, keeping line and column honest.
   *
   * `\r\n` counts as ONE line break: the `\r` defers to the `\n` that follows
   * it, and a lone `\r` breaks the line itself. Getting this wrong on a CRLF
   * file shifts every position after line one by a whole line, which is both
   * very visible and very hard to attribute.
   */
  const advance = (count: number): void => {
    for (let i = 0; i < count; i++) {
      const ch = source[offset]
      offset++

      if (ch === '\n') {
        line++
        column = 1
      } else if (ch === '\r') {
        if (source[offset] !== '\n') {
          line++
          column = 1
        }
      } else {
        column++
      }
    }
  }

  /** Emits a token spanning a remembered start to the current position. */
  const emit = (
    kind: TokenKind,
    startOffset: number,
    startLine: number,
    startColumn: number
  ): void => {
    const span: Span = {
      offset: startOffset,
      length: offset - startOffset,
      startLine,
      startColumn,
      endLine: line,
      endColumn: column
    }
    tokens.push({ kind, text: source.slice(startOffset, offset), span })
  }

  while (offset < source.length) {
    const startOffset = offset
    const startLine = line
    const startColumn = column
    const ch = peek()

    /* ------------------------------- trivia ------------------------------- */

    if (isSpace(ch)) {
      while (offset < source.length && isSpace(peek())) advance(1)
      emit('whitespace', startOffset, startLine, startColumn)
      continue
    }

    if (ch === '/' && peek(1) === '/') {
      while (offset < source.length && peek() !== '\n' && peek() !== '\r') advance(1)
      emit('comment', startOffset, startLine, startColumn)
      continue
    }

    if (ch === '/' && peek(1) === '*') {
      advance(2)
      let closed = false
      while (offset < source.length) {
        if (peek() === '*' && peek(1) === '/') {
          advance(2)
          closed = true
          break
        }
        advance(1)
      }
      // An unterminated block comment runs to end of file, and is reported as an
      // error rather than a comment so the parser can say something useful about
      // it. It still consumes the rest of the input, which is what the author
      // meant and what every other editor does.
      emit(closed ? 'comment' : 'error', startOffset, startLine, startColumn)
      continue
    }

    /* -------------------------- numbers and names ------------------------- */

    if (isDigit(ch)) {
      while (isDigit(peek())) advance(1)
      emit('int', startOffset, startLine, startColumn)
      continue
    }

    if (isIdentifierStart(ch)) {
      while (isIdentifierPart(peek())) advance(1)
      // Looked up AFTER the whole word is scanned, so `letter` is one identifier
      // rather than `let` followed by `ter`.
      emit(KEYWORDS.get(source.slice(startOffset, offset)) ?? 'identifier', startOffset, startLine, startColumn)
      continue
    }

    /* ---------------------- operators and punctuation --------------------- */

    const twoCharKind = TWO_CHAR.get(ch + peek(1))
    if (twoCharKind !== undefined) {
      advance(2)
      emit(twoCharKind, startOffset, startLine, startColumn)
      continue
    }

    const oneCharKind = ONE_CHAR.get(ch)
    if (oneCharKind !== undefined) {
      advance(1)
      emit(oneCharKind, startOffset, startLine, startColumn)
      continue
    }

    /* ----------------------------- anything else -------------------------- */

    // One error token per RUN of unrecognised characters, not one per character:
    // a paragraph of prose pasted into a source file should produce a handful of
    // diagnostics rather than several hundred.
    while (offset < source.length && isUnrecognised(source, offset)) advance(1)
    emit('error', startOffset, startLine, startColumn)
  }

  // Zero-width, at the end. Every parser needs something to stop on, and giving
  // it a real position means a diagnostic reported at end-of-file still has
  // somewhere for the editor to draw a squiggle.
  tokens.push({
    kind: 'eof',
    text: '',
    span: {
      offset,
      length: 0,
      startLine: line,
      startColumn: column,
      endLine: line,
      endColumn: column
    }
  })

  return tokens
}

/**
 * Would this position start a real token?
 *
 * Only used to decide how far an error run extends, and expressed in terms of
 * the same tables the scanner consults — so a character can never be both
 * "unrecognised" and lexable, and adding an operator to the tables shortens
 * error runs automatically rather than needing a matching edit here.
 */
function isUnrecognised(source: string, at: number): boolean {
  const ch = source[at] ?? EOF_CHAR
  if (ch === EOF_CHAR) return false
  if (isDigit(ch) || isIdentifierStart(ch) || isSpace(ch)) return false
  if (ONE_CHAR.has(ch)) return false
  if (TWO_CHAR.has(ch + (source[at + 1] ?? EOF_CHAR))) return false
  return true
}

/** Consulted before the one-character table, so `==` never lexes as two `=`. */
const TWO_CHAR: ReadonlyMap<string, TokenKind> = new Map<string, TokenKind>([
  ['==', 'equals'],
  ['!=', 'notEquals'],
  ['<=', 'lessEqual'],
  ['>=', 'greaterEqual'],
  ['&&', 'and'],
  ['||', 'or'],
  ['->', 'arrow']
])

const ONE_CHAR: ReadonlyMap<string, TokenKind> = new Map<string, TokenKind>([
  ['+', 'plus'],
  ['-', 'minus'],
  ['*', 'star'],
  ['/', 'slash'],
  ['%', 'percent'],
  ['=', 'assign'],
  ['!', 'not'],
  ['<', 'less'],
  ['>', 'greater'],
  ['(', 'leftParen'],
  [')', 'rightParen'],
  ['{', 'leftBrace'],
  ['}', 'rightBrace'],
  [',', 'comma'],
  [';', 'semicolon'],
  [':', 'colon']
])
