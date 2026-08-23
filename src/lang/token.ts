/**
 * Tokens for BCC, the language this IDE compiles.
 *
 * `src/lang/` is the compiler. It holds to the same purity discipline as
 * `src/shared/` — no node, no electron, no typescript, no DOM — but is separate
 * from it because `src/shared/` is about IPC and protocol, and a compiler is
 * neither. The discipline is enforced rather than documented: this tree is
 * compiled by BOTH tsconfig projects, and the node project has no DOM lib while
 * the web project has no node types, so each one rejects what the other would
 * allow.
 *
 * ## Spans are the whole point
 *
 * Every token carries where it came from, and every later stage threads that
 * through: the AST, the IR, the SSA form, the bytecode. It is what makes
 * click-anywhere-in-the-Observatory-to-highlight-the-source work at the end, and
 * retrofitting it after the fact is close to impossible — a stage that dropped
 * its spans cannot invent them again.
 */

/**
 * A half-open region of source: `[offset, offset + length)`.
 *
 * `offset` and `length` are indices into the JavaScript string, which means
 * UTF-16 code units and NOT bytes. Called out because the distinction is
 * invisible until the first non-ASCII identifier or string appears, at which
 * point a "byte offset" that was really a code-unit index silently points at the
 * wrong place. Monaco counts columns the same way, so this is also the unit that
 * makes editor positions line up without conversion.
 *
 * Lines and columns are 1-based, matching Monaco, tsc and every diagnostic in
 * this codebase (`src/shared/types.ts`). `endColumn` is exclusive, so a
 * zero-width span at end-of-file has `startColumn === endColumn`.
 */
export interface Span {
  readonly offset: number
  readonly length: number
  readonly startLine: number
  readonly startColumn: number
  readonly endLine: number
  readonly endColumn: number
}

/**
 * Every kind of token, including the ones a parser throws away.
 *
 * Whitespace and comments are TOKENS here rather than skipped, which is a
 * deliberate choice with two payoffs. It lets the lexer's output tile the source
 * exactly — concatenate every token's text and you get the input back, which is
 * a property strong enough to catch essentially every span bug in one test. And
 * the Observatory can show a token stream that looks like the file the user
 * wrote, rather than a stream with holes in it.
 *
 * The parser skips trivia via `isTrivia`.
 */
export type TokenKind =
  // trivia — carried, not discarded
  | 'whitespace'
  | 'comment'
  // literals and names
  | 'int'
  | 'identifier'
  // keywords
  | 'let'
  | 'if'
  | 'else'
  | 'while'
  | 'fn'
  | 'return'
  | 'print'
  | 'true'
  | 'false'
  // operators
  | 'plus'
  | 'minus'
  | 'star'
  | 'slash'
  | 'percent'
  | 'assign'
  | 'equals'
  | 'notEquals'
  | 'not'
  | 'less'
  | 'lessEqual'
  | 'greater'
  | 'greaterEqual'
  | 'and'
  | 'or'
  // punctuation
  | 'leftParen'
  | 'rightParen'
  | 'leftBrace'
  | 'rightBrace'
  | 'comma'
  | 'semicolon'
  | 'colon'
  | 'arrow'
  // ends
  | 'error'
  | 'eof'

export interface Token {
  readonly kind: TokenKind
  /** The exact source text. Concatenating these in order rebuilds the input. */
  readonly text: string
  readonly span: Span
}

/**
 * Words that are keywords rather than identifiers.
 *
 * Recognised AFTER scanning a whole identifier rather than by matching prefixes,
 * so `letter` lexes as one identifier rather than `let` followed by `ter`.
 */
export const KEYWORDS: ReadonlyMap<string, TokenKind> = new Map([
  ['let', 'let'],
  ['if', 'if'],
  ['else', 'else'],
  ['while', 'while'],
  ['fn', 'fn'],
  ['return', 'return'],
  ['print', 'print'],
  ['true', 'true'],
  ['false', 'false']
] as [string, TokenKind][])

/** Trivia carries no meaning to the parser, only to the source text. */
export function isTrivia(kind: TokenKind): boolean {
  return kind === 'whitespace' || kind === 'comment'
}

/** Human-readable, for diagnostics: `'let'`, `'an identifier'`, `'end of file'`. */
export function describeKind(kind: TokenKind): string {
  switch (kind) {
    case 'identifier':
      return 'an identifier'
    case 'int':
      return 'a number'
    case 'eof':
      return 'end of file'
    case 'error':
      return 'an unrecognised character'
    case 'whitespace':
      return 'whitespace'
    case 'comment':
      return 'a comment'
    default:
      return `'${SPELLING.get(kind) ?? kind}'`
  }
}

/**
 * How each fixed-text token is written.
 *
 * One table, used by `describeKind` and available to a future formatter, so the
 * spelling of a token lives in exactly one place.
 */
const SPELLING: ReadonlyMap<TokenKind, string> = new Map([
  ['plus', '+'],
  ['minus', '-'],
  ['star', '*'],
  ['slash', '/'],
  ['percent', '%'],
  ['assign', '='],
  ['equals', '=='],
  ['notEquals', '!='],
  ['not', '!'],
  ['less', '<'],
  ['lessEqual', '<='],
  ['greater', '>'],
  ['greaterEqual', '>='],
  ['and', '&&'],
  ['or', '||'],
  ['leftParen', '('],
  ['rightParen', ')'],
  ['leftBrace', '{'],
  ['rightBrace', '}'],
  ['comma', ','],
  ['semicolon', ';'],
  ['colon', ':'],
  ['arrow', '->']
] as [TokenKind, string][])
