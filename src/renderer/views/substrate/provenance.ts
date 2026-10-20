import type { Span } from '../../../lang/token'
import type { AstRecord, CompileResult, DiagnosticRecord, InstructionRecord, SymbolRecord, TokenRecord } from './compile'

/**
 * "What did this piece of source become, at every stage?"
 *
 * Every IR and SSA instruction carries the span it was lowered from — Part 5
 * threads it from the lexer onward specifically so a breakpoint (or, here, a
 * click) can be looked up to an instruction. This is that lookup.
 */
export interface Provenance {
  readonly offset: number
  readonly token: TokenRecord | null
  readonly node: AstRecord | null
  readonly symbol: SymbolRecord | null
  readonly span: Span | null
  readonly ir: readonly InstructionRecord[]
  readonly ssa: readonly InstructionRecord[]
  readonly diagnostics: readonly DiagnosticRecord[]
}

function spanHas(span: Span, offset: number): boolean {
  return offset >= span.offset && offset < span.offset + Math.max(span.length, 1)
}

function overlaps(a: Span | null, b: Span | null): boolean {
  if (!a || !b) return false
  return a.offset < b.offset + Math.max(b.length, 1) && b.offset < a.offset + Math.max(a.length, 1)
}

/** `a` lies entirely inside `b` — "a was lowered from b". */
function within(a: Span | null, b: Span | null): boolean {
  if (!a || !b) return false
  return a.offset >= b.offset && a.offset + a.length <= b.offset + Math.max(b.length, 1)
}

export function provenanceAt(result: CompileResult, offset: number): Provenance | null {
  // `eof` is a real token but not a construct anyone can ask about — resting
  // the caret at the end of the file should read as "nothing selected".
  let token: TokenRecord | null = null
  for (const tok of result.tokens) {
    if (tok.kind === 'eof') continue
    if (spanHas(tok.span, offset)) {
      token = tok
      break
    }
  }

  // The deepest AST node containing the offset is the construct the user means.
  let node: AstRecord | null = null
  for (const n of result.ast) {
    if (!n.span || !spanHas(n.span, offset)) continue
    if (!node || n.span.length <= (node.span?.length ?? Infinity)) node = n
  }

  const probe = node?.span ?? token?.span ?? null

  // A declaration is usually selected by its keyword, not its name — clicking
  // `fn` should still tell you about the function it introduces.
  let named: string | null = null
  const match = node ? /^(?:Function|Let|Assign|Ident|Name|Call) (.+)$/.exec(node.label) : null
  if (match) named = match[1] ?? null
  const ident = token && token.kind === 'identifier' ? token.text : named

  // The resolver already decided which binding the construct names; matching
  // on the name instead would hand a shadowing `let x` the outer `x`. The name
  // is only a fallback for a construct the resolver recorded nothing for.
  const binding = node?.binding ?? null
  let symbol: SymbolRecord | null = null
  if (binding) {
    symbol = result.symbols.find((s) => s.span?.offset === binding.offset && s.span.length === binding.length) ?? null
  } else if (ident) {
    symbol = result.symbols.find((s) => s.name === ident) ?? null
  }

  // What did this source range become? Containment, not overlap — an
  // instruction belongs to the construct when it was lowered from inside the
  // range. Overlap would drag in every enclosing statement's terminator, so
  // selecting a loop variable would light the whole loop.
  const pick = (fns: CompileResult['ir']): InstructionRecord[] => {
    const all: InstructionRecord[] = []
    for (const fn of fns) for (const block of fn.blocks) all.push(...block.instructions, block.terminator)

    const hits: InstructionRecord[] = []
    const seen = new Set<InstructionRecord>()
    const add = (x: InstructionRecord): void => {
      if (!seen.has(x)) {
        seen.add(x)
        hits.push(x)
      }
    }

    for (const ins of all) if (within(ins.span, probe)) add(ins)

    // A phi carries the variable it was created for — the only link back to
    // source for a store SSA has promoted away. Without it, selecting a loop
    // variable shows nothing at the SSA stage, which is the one stage where
    // something interesting actually happened to it.
    if (ident) {
      for (const ins of all) if (ins.isPhi && ins.text.includes(`; ${ident}`)) add(ins)
    }
    if (hits.length) return hits

    // Finer than any instruction (an identifier, an operator): fall back to the
    // tightest enclosing instruction, restricted to single-line spans — a while
    // loop's terminator encloses every line in its body, and would answer "the
    // whole loop" to a question about one variable.
    const oneLine = (s: Span): boolean => s.startLine === s.endLine
    let best = Infinity
    for (const ins of all) if (within(probe, ins.span) && oneLine(ins.span)) best = Math.min(best, ins.span.length)
    if (best === Infinity) return []
    for (const ins of all) if (within(probe, ins.span) && oneLine(ins.span) && ins.span.length === best) add(ins)
    return hits
  }

  const diagnostics = result.diagnostics.filter((d) => overlaps(d.span, probe))

  return {
    offset,
    token,
    node,
    symbol,
    span: probe,
    ir: result.blocked ? [] : pick(result.ir),
    ssa: result.blocked ? [] : pick(result.ssa),
    diagnostics
  }
}
