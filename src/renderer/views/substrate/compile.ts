import { tokenize } from '../../../lang/lexer'
import { parseSource } from '../../../lang/parser'
import { resolve } from '../../../lang/symbols'
import { typeCheck, describeType, type Type } from '../../../lang/type-check'
import { lower } from '../../../lang/lower'
import { toSsa } from '../../../lang/ssa'
import { verifyModule, VERIFICATION_RULES, type VerificationRule } from '../../../lang/verify'
import { DIAGNOSTIC_TITLES, type DiagnosticCode, type DiagnosticSeverity } from '../../../lang/diagnostic'
import { isTrivia, type Span, type TokenKind } from '../../../lang/token'
import {
  printFunction,
  successorsOf,
  definitionOf,
  usesOf,
  type IrFunction,
  type Instruction,
  type Operand,
  type Module,
  type Terminator
} from '../../../lang/ir'

/**
 * Flattens the real BCC pipeline into plain data the Substrate view can render
 * without importing compiler types into the DOM layer. Every record keeps the
 * span it was built from, which is what makes cross-stage provenance a lookup
 * rather than a guess — see `provenance.ts`.
 */

export interface InstructionRecord {
  readonly text: string
  readonly op: string
  readonly fn: string
  readonly block: string
  readonly def: number | null
  readonly uses: readonly number[]
  readonly isPhi: boolean
  readonly isTerminator: boolean
  readonly span: Span
}

export interface BlockRecord {
  readonly id: number
  readonly label: string
  readonly instructions: readonly InstructionRecord[]
  readonly terminator: InstructionRecord
  readonly successors: readonly number[]
}

export interface FunctionRecord {
  readonly name: string
  readonly signature: string
  readonly printed: string
  readonly span: Span
  readonly blocks: readonly BlockRecord[]
}

export interface TokenRecord {
  readonly kind: TokenKind
  readonly text: string
  readonly span: Span
}

export interface AstRecord {
  readonly id: number
  readonly parent: number | null
  readonly depth: number
  readonly label: string
  readonly kind: string
  readonly type: string | null
  readonly span: Span | null
}

export interface SymbolRecord {
  readonly name: string
  readonly kind: 'variable' | 'parameter' | 'function'
  readonly depth: number
  readonly type: string | null
  readonly span: Span | null
}

export interface DiagnosticRecord {
  readonly code: DiagnosticCode
  readonly severity: DiagnosticSeverity
  readonly message: string
  readonly title: string
  readonly span: Span
}

export interface ViolationRecord {
  readonly rule: VerificationRule
  readonly message: string
  readonly fn: string
  readonly block: string | null
  readonly title: string
}

export interface CompileResult {
  readonly source: string
  readonly ok: boolean
  readonly blocked: boolean
  readonly timings: Readonly<Record<string, number>>
  readonly tokens: readonly TokenRecord[]
  readonly tokenCount: number
  readonly ast: readonly AstRecord[]
  readonly symbols: readonly SymbolRecord[]
  readonly diagnostics: readonly DiagnosticRecord[]
  readonly ir: readonly FunctionRecord[]
  readonly ssa: readonly FunctionRecord[]
  readonly violations: readonly ViolationRecord[]
}

function operandText(o: Operand): string {
  return o.kind === 'value' ? `%${o.id}` : String(o.value)
}

function instructionRecord(ins: Instruction, block: string, fn: string): InstructionRecord {
  const def = definitionOf(ins)
  let text: string
  switch (ins.op) {
    case 'alloca':
      text = `%${ins.result} = alloca ${describeType(ins.type)}   ; ${ins.name}`
      break
    case 'load':
      text = `%${ins.result} = load %${ins.slot}`
      break
    case 'store':
      text = `store ${operandText(ins.value)} -> %${ins.slot}`
      break
    case 'binary':
      text = `%${ins.result} = ${ins.operator} ${operandText(ins.left)}, ${operandText(ins.right)}`
      break
    case 'unary':
      text = `%${ins.result} = ${ins.operator} ${operandText(ins.operand)}`
      break
    case 'call':
      text = `${ins.result === null ? '' : `%${ins.result} = `}call ${ins.callee}(${ins.args.map(operandText).join(', ')})`
      break
    case 'phi':
      text = `%${ins.result} = phi ${ins.incoming.map((i) => `[${operandText(i.value)}, b${i.from}]`).join(' ')}   ; ${ins.name}`
      break
    case 'print':
      text = `print ${operandText(ins.value)}`
      break
    default:
      text = JSON.stringify(ins)
  }
  return {
    text,
    op: ins.op,
    fn,
    block,
    def,
    uses: usesOf(ins),
    isPhi: ins.op === 'phi',
    isTerminator: false,
    span: ins.span
  }
}

function terminatorRecord(fnName: string, blockLabel: string, t: Terminator): InstructionRecord {
  let text: string
  switch (t.op) {
    case 'jump':
      text = `jump b${t.target}`
      break
    case 'branch':
      text = `branch ${operandText(t.condition)} ? b${t.ifTrue} : b${t.ifFalse}`
      break
    case 'return':
      text = t.value ? `return ${operandText(t.value)}` : 'return'
      break
    default:
      text = 'unreachable'
  }
  return {
    text,
    op: t.op,
    fn: fnName,
    block: blockLabel,
    def: null,
    uses: [],
    isPhi: false,
    isTerminator: true,
    span: t.span
  }
}

function functionRecord(fn: IrFunction): FunctionRecord {
  return {
    name: fn.name,
    signature: `${fn.name}(${fn.params.map((p) => `%${p.value}: ${describeType(p.type)}`).join(', ')}) -> ${describeType(fn.returnType)}`,
    printed: printFunction(fn),
    span: fn.span,
    blocks: fn.blocks.map((b) => ({
      id: b.id,
      label: b.label,
      instructions: b.instructions.map((i) => instructionRecord(i, b.label, fn.name)),
      terminator: terminatorRecord(fn.name, b.label, b.terminator),
      successors: successorsOf(b.terminator)
    }))
  }
}

const AST_CHILD_KEYS = [
  'statements',
  'body',
  'params',
  'args',
  'left',
  'right',
  'operand',
  'value',
  'condition',
  'then',
  'otherwise',
  'callee',
  'target',
  'name',
  'declaredType',
  'returnType',
  'initializer',
  'expression'
] as const

/** Walks the AST into a flat list — a tree via `parent`/`depth`, easy to render as rows. */
function astRecords(program: { statements: readonly unknown[]; span: Span }, types: ReadonlyMap<unknown, Type>): AstRecord[] {
  const out: AstRecord[] = []
  let next = 0

  const walk = (node: unknown, parent: number | null, depth: number): void => {
    if (!node || typeof node !== 'object' || !('kind' in node)) return
    const n = node as Record<string, unknown> & { kind: string; span?: Span }
    const id = next++
    const type = types.get(node)
    let label = n.kind
    if (n.kind === 'Binary' || n.kind === 'Logical') label = `${n.kind} ${String(n['operator'])}`
    else if (n.kind === 'Unary') label = `Unary ${String(n['operator'])}`
    else if (n.kind === 'Int' || n.kind === 'Bool') label = `${n.kind} ${String(n['value'])}`
    else if (n.kind === 'Ident') label = `Ident ${String(n['text'] ?? '')}`
    else if (n.kind === 'TypeRef') label = `TypeRef ${String(n['name'] ?? '')}`
    else if (n.kind === 'Name') label = `Name ${String(n['text'] ?? '')}`
    else if (n.kind === 'Call') {
      const callee = n['callee'] as { text?: string } | undefined
      label = `Call ${callee?.text ?? ''}`
    } else if (n.kind === 'Function') {
      const name = n['name'] as { text?: string } | undefined
      label = `Function ${name?.text ?? ''}`
    } else if (n.kind === 'Let') {
      const name = n['name'] as { text?: string } | undefined
      label = `Let ${name?.text ?? ''}`
    } else if (n.kind === 'Assign') {
      const target = n['target'] as { text?: string } | undefined
      label = `Assign ${target?.text ?? ''}`
    }
    out.push({ id, parent, depth, label, kind: n.kind, type: type ? describeType(type) : null, span: n.span ?? null })
    for (const key of AST_CHILD_KEYS) {
      const child = n[key]
      if (Array.isArray(child)) for (const c of child) walk(c, id, depth + 1)
      else if (child && typeof child === 'object') walk(child, id, depth + 1)
    }
  }

  const rootId = next++
  out.push({ id: rootId, parent: null, depth: 0, label: 'Program', kind: 'Program', type: null, span: program.span })
  for (const s of program.statements) walk(s, rootId, 1)
  return out
}

function timed<T>(timings: Record<string, number>, name: string, f: () => T): T {
  const start = performance.now()
  const result = f()
  timings[name] = performance.now() - start
  return result
}

export function compile(source: string): CompileResult {
  const timings: Record<string, number> = {}

  const tokens = timed(timings, 'tokens', () => tokenize(source))
  const parsed = timed(timings, 'ast', () => parseSource(source))
  const resolution = timed(timings, 'resolve', () => resolve(parsed.program))
  const typeInfo = timed(timings, 'types', () => typeCheck(parsed.program, resolution))

  const diagnostics: DiagnosticRecord[] = [...parsed.diagnostics, ...resolution.diagnostics, ...typeInfo.diagnostics].map(
    (d) => ({
      code: d.code,
      severity: d.severity,
      message: d.message,
      title: DIAGNOSTIC_TITLES[d.code],
      span: d.span
    })
  )

  // Lowering a program with errors in it is not meaningful; downstream stages
  // report blocked rather than inventing an IR that no source justifies.
  const blocked = diagnostics.some((d) => d.severity === 'error')

  let ir: Module | null = null
  let ssa: Module | null = null
  let violations: ViolationRecord[] = []

  if (!blocked) {
    ir = timed(timings, 'ir', () => lower(parsed.program, resolution, typeInfo))
    ssa = timed(timings, 'ssa', () => ({ functions: ir!.functions.map(toSsa) }))
    violations = timed(timings, 'verify', () =>
      verifyModule(ssa!).map((v) => ({
        rule: v.rule,
        message: v.message,
        fn: v.fn,
        block: v.block,
        title: VERIFICATION_RULES[v.rule]
      }))
    )
  }

  const symbols: SymbolRecord[] = []
  const collectScope = (scope: (typeof resolution)['scope'], depth: number): void => {
    for (const s of scope.symbols) {
      symbols.push({
        name: s.name,
        kind: s.kind,
        depth,
        type: typeInfo.symbolTypes.has(s) ? describeType(typeInfo.symbolTypes.get(s)!) : null,
        span: s.declaration.span
      })
    }
    for (const child of scope.children) collectScope(child, depth + 1)
  }
  collectScope(resolution.scope, 0)

  return {
    source,
    ok: !blocked && violations.length === 0,
    blocked,
    timings,
    tokens: tokens.filter((tok) => !isTrivia(tok.kind)).map((tok) => ({ kind: tok.kind, text: tok.text, span: tok.span })),
    tokenCount: tokens.length,
    ast: astRecords(parsed.program, typeInfo.types),
    symbols,
    diagnostics,
    ir: ir ? ir.functions.map(functionRecord) : [],
    ssa: ssa ? ssa.functions.map(functionRecord) : [],
    violations
  }
}
