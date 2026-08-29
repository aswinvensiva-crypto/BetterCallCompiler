import type { Span } from './token'

/**
 * What every stage of BCC says when something is wrong.
 *
 * One type, shared by the lexer's error tokens, the parser, the resolver and the
 * type checker, because the alternative is four shapes that all have to be
 * flattened into `FileDiagnostics` in Part 3 anyway.
 *
 * ## Codes
 *
 * The plan introduces stable `BCC0001…` codes in Part 4. They start here
 * instead, because a code is only stable if it never changes, and renumbering
 * the parser's diagnostics later to make room would break exactly the promise
 * the codes exist to make. Part 4 continues the numbering rather than starting
 * it.
 *
 * Codes are what the Observatory, the Problems panel and the AI key on. The
 * message is for a human and may be reworded; the code may not.
 */

export type DiagnosticCode =
  // Lexical — raised by the parser on the error tokens the lexer produced,
  // because the lexer has nowhere to put a diagnostic and no need for one.
  | 'BCC0001'
  | 'BCC0002'
  // Syntactic
  | 'BCC0003'
  | 'BCC0004'
  | 'BCC0005'
  | 'BCC0006'
  | 'BCC0007'

export type DiagnosticSeverity = 'error' | 'warning'

export interface Diagnostic {
  readonly code: DiagnosticCode
  readonly severity: DiagnosticSeverity
  /** For a human. Interpolated per occurrence, unlike the title. */
  readonly message: string
  readonly span: Span
}

/**
 * The category behind each code, one line each.
 *
 * A total `Record`, so adding a code without describing it is a compile error —
 * the same trick `ipc-contract.ts` uses to keep its channel table complete. It
 * also makes the set of diagnostics enumerable, which is what lets a
 * documentation page or a test iterate them rather than list them by hand.
 */
export const DIAGNOSTIC_TITLES: Readonly<Record<DiagnosticCode, string>> = {
  BCC0001: 'unrecognised characters',
  BCC0002: 'unterminated block comment',
  BCC0003: 'unexpected token',
  BCC0004: 'expected an expression',
  BCC0005: 'integer literal out of range',
  BCC0006: 'invalid assignment target',
  BCC0007: 'nesting too deep to parse'
}

export function error(code: DiagnosticCode, message: string, span: Span): Diagnostic {
  return { code, severity: 'error', message, span }
}
