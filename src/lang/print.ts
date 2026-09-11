import type { Node, Program } from './ast'
import { childrenOf } from './ast'
import { printInstruction as printBytecodeInstruction, type CompiledFunction } from './bytecode'
import {
  printInstruction as printIrInstruction,
  printTerminator,
  type BlockId,
  type IrFunction
} from './ir'
import type { Scope } from './symbols'
import type { Span, Token } from './token'
import { describeType } from './type-check'

/**
 * One line of an Observatory tab: text a person reads, and the source region a
 * click on it should reveal.
 *
 * Every printer below produces `readonly CodeLine[]` rather than a joined
 * string, because that span is the whole payoff of threading one through every
 * stage since Part 1. `span: null` marks a line that names no single place in
 * the source — a block label, a closing brace — rather than pointing it at
 * something misleading.
 */
export interface CodeLine {
  readonly text: string
  readonly span: Span | null
}

function line(text: string, span: Span | null): CodeLine {
  return { text, span }
}

/* -------------------------------------------------------------------------- */
/*  Tokens                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One line per token, trivia included.
 *
 * `token.ts` keeps whitespace and comments as tokens specifically so a token
 * stream "looks like the file the user wrote, rather than a stream with holes
 * in it" — dropping them here would quietly undo that design choice.
 */
export function printTokenLines(tokens: readonly Token[]): readonly CodeLine[] {
  return tokens.map((token) => line(`${token.kind}  ${JSON.stringify(token.text)}`, token.span))
}

/* -------------------------------------------------------------------------- */
/*  AST                                                                        */
/* -------------------------------------------------------------------------- */

/** A short, human label for one node — the text `printAstLines` indents. */
function describeAstNode(node: Node): string {
  switch (node.kind) {
    case 'Program':
      return 'Program'
    case 'Ident':
      return `Ident ${node.text}`
    case 'TypeRef':
      return `TypeRef ${node.name}`
    case 'Param':
      return 'Param'
    case 'Int':
      return `Int ${node.text}`
    case 'Bool':
      return `Bool ${String(node.value)}`
    case 'Name':
      return `Name ${node.text}`
    case 'Unary':
      return `Unary ${node.operator}`
    case 'Binary':
      return `Binary ${node.operator}`
    case 'Logical':
      return `Logical ${node.operator}`
    case 'Call':
      return 'Call'
    case 'ErrorExpr':
      return 'ErrorExpr'
    case 'Let':
      return `Let ${node.name.text}`
    case 'Assign':
      return `Assign ${node.target.text}`
    case 'If':
      return 'If'
    case 'While':
      return 'While'
    case 'Return':
      return 'Return'
    case 'Print':
      return 'Print'
    case 'ExprStmt':
      return 'ExprStmt'
    case 'Block':
      return 'Block'
    case 'Function':
      return `Function ${node.name.text}`
    case 'ErrorStmt':
      return 'ErrorStmt'
  }
}

/**
 * The whole tree, indented two spaces per level, in source order.
 *
 * Source order and full coverage come free from `childrenOf` — the same walk
 * `syntax-tree.ts`'s span-containment property test already trusts.
 */
export function printAstLines(root: Node, indent = 0): readonly CodeLine[] {
  const lines: CodeLine[] = [line(`${'  '.repeat(indent)}${describeAstNode(root)}`, root.span)]
  for (const child of childrenOf(root)) lines.push(...printAstLines(child, indent + 1))
  return lines
}

/* -------------------------------------------------------------------------- */
/*  Symbols                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The scope tree symbols.ts already built while resolving — see its own doc
 * comment on `Scope` for why this is not a second implementation of scoping.
 */
export function printScopeLines(scope: Scope, indent = 0): readonly CodeLine[] {
  const lines: CodeLine[] = [line(`${'  '.repeat(indent)}${scope.kind} scope`, scope.span)]

  for (const symbol of scope.symbols) {
    lines.push(
      line(
        `${'  '.repeat(indent + 1)}${symbol.kind} ${symbol.name}`,
        symbol.declaration.span
      )
    )
  }

  for (const child of scope.children) lines.push(...printScopeLines(child, indent + 1))

  return lines
}

/* -------------------------------------------------------------------------- */
/*  IR and SSA — the same shape, since SSA is `IrFunction` with phis           */
/* -------------------------------------------------------------------------- */

/**
 * `ir.ts`'s `printFunction`, exploded into one `CodeLine` per line instead of a
 * joined string, so the Observatory can put a click handler on any of them.
 * Reuses the exported `printOperand`/`printInstruction`/`printTerminator`
 * rather than re-deriving the same text a second way — a printer that drifted
 * from the golden-tested one would show the reader something subtly different
 * from what `ir.ts` itself considers true.
 */
export function printFunctionLines(fn: IrFunction): readonly CodeLine[] {
  const labelOf = (id: BlockId): string =>
    fn.blocks.find((block) => block.id === id)?.label ?? `^${id}`

  const signature = fn.params
    .map((param) => `%${param.value}: ${describeType(param.type)}`)
    .join(', ')

  const lines: CodeLine[] = [
    line(`fn ${fn.name}(${signature}) -> ${describeType(fn.returnType)} {`, fn.span)
  ]

  for (const block of fn.blocks) {
    // A block label names no single instruction; `null` says so rather than
    // pointing the click at whichever instruction happens to be first.
    lines.push(line(`${block.label}:`, null))
    for (const instruction of block.instructions) {
      lines.push(line(`  ${printIrInstruction(instruction, labelOf)}`, instruction.span))
    }
    lines.push(line(`  ${printTerminator(block.terminator, labelOf)}`, block.terminator.span))
  }

  lines.push(line('}', null))
  return lines
}

/* -------------------------------------------------------------------------- */
/*  Bytecode                                                                   */
/* -------------------------------------------------------------------------- */

export function printBytecodeLines(fn: CompiledFunction): readonly CodeLine[] {
  const lines: CodeLine[] = [line(`fn ${fn.name}/${fn.arity} slots=${fn.slots} {`, fn.span)]

  fn.code.forEach((instr, index) => {
    lines.push(
      line(`${String(index).padStart(4, ' ')}  ${printBytecodeInstruction(instr)}`, instr.span)
    )
  })

  lines.push(line('}', null))
  return lines
}

/** The whole `Program` node's own span, for the AST tab's root line. */
export function programSpan(program: Program): Span {
  return program.span
}
