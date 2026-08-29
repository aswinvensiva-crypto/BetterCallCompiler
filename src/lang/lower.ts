import type {
  BlockStmt,
  Expr,
  FunctionDecl,
  Program,
  Stmt
} from './ast'
import {
  constant,
  successorsOf,
  value,
  type Block,
  type BlockId,
  type Instruction,
  type IrFunction,
  type IrParam,
  type Module,
  type Operand,
  type Terminator,
  type ValueId
} from './ir'
import type { Resolution, SymbolInfo } from './symbols'
import { ERROR, UNIT, type Type, type TypeInfo } from './type-check'
import type { Span } from './token'

/**
 * Lowering: the AST to the IR.
 *
 * Runs after resolution and type checking, and depends on both — it asks the
 * resolver which declaration a name refers to so it can find that variable's
 * slot, and it asks the checker for a call's result type so it knows whether
 * the call names a value.
 *
 * ## The name of the top-level function
 *
 * Statements written outside any function are collected into a synthetic
 * function called `<main>`. Angle brackets are not in the lexer's identifier
 * alphabet, so no source file can declare a function with that name and the
 * collision is impossible by construction rather than merely unlikely. It is
 * also visibly synthetic in the Observatory, which is honest: a reader should
 * be able to tell which function they wrote.
 *
 * ## Short-circuiting is where the plan starts paying off
 *
 * `a && b` lowers to a branch, a slot and a join. That looks like a lot of
 * machinery for one operator, and it is exactly the point: Part 6 puts a phi at
 * that join and Part 8's mem2reg deletes the slot, and a reader watches an `&&`
 * turn into control flow and then back into a value. `Logical` is a separate
 * AST node from `Binary` precisely so this path cannot be forgotten.
 *
 * ## What happens after a return
 *
 * Statements following a terminator in the same block are dropped. They cannot
 * run, and emitting them into an unreachable block would put code in the
 * Observatory that no path reaches. The better answer for a user is an
 * "unreachable code" warning from the checker, which BCC does not have yet —
 * noted rather than half-built.
 */

/** Impossible to write in source: `<` and `>` are not identifier characters. */
export const TOP_LEVEL_FUNCTION = '<main>'

export function lower(
  program: Program,
  resolution: Resolution,
  typeInfo: TypeInfo
): Module {
  const functions: IrFunction[] = []

  for (const statement of program.statements) {
    if (statement.kind !== 'Function') continue
    functions.push(lowerFunction(statement, resolution, typeInfo))
  }

  // Everything that is not a function declaration becomes the program's body.
  // Emitted even when empty, so Part 9 always has an entry point to run.
  const topLevel = program.statements.filter((statement) => statement.kind !== 'Function')
  functions.push(lowerTopLevel(topLevel, program.span, resolution, typeInfo))

  return { functions }
}

/* -------------------------------------------------------------------------- */
/*  The builder                                                                */
/* -------------------------------------------------------------------------- */

/** Rewrites a terminator's targets after blocks have been renumbered. */
function retarget(terminator: Terminator, to: (id: BlockId) => BlockId): Terminator {
  switch (terminator.op) {
    case 'jump':
      return { ...terminator, target: to(terminator.target) }
    case 'branch':
      return { ...terminator, ifTrue: to(terminator.ifTrue), ifFalse: to(terminator.ifFalse) }
    case 'return':
    case 'unreachable':
      return terminator
  }
}

interface PendingBlock {
  readonly id: BlockId
  /** `then`, `while.head` — the numeric suffix is added once ids are final. */
  readonly base: string
  readonly instructions: Instruction[]
  terminator: Terminator | null
}

function lowerFunction(
  declaration: FunctionDecl,
  resolution: Resolution,
  typeInfo: TypeInfo
): IrFunction {
  const builder = createBuilder(declaration.name.text, declaration.span, resolution, typeInfo)

  // Every incoming value is reserved BEFORE any slot is, so a two-parameter
  // function reads `fn add(%0: int, %1: int)` rather than `%0, %2`. Purely for
  // the reader; the Observatory shows this signature.
  const params: IrParam[] = declaration.params.map((param) => {
    const symbol = resolution.declarations.get(param.name)
    const type = symbol === undefined ? ERROR : (typeInfo.symbolTypes.get(symbol) ?? ERROR)
    return { name: param.name.text, value: builder.nextValue(), type }
  })

  declaration.params.forEach((param, index) => {
    const symbol = resolution.declarations.get(param.name)
    const incoming = params[index]
    if (symbol === undefined || incoming === undefined) return

    // Copied into a slot immediately, exactly as clang does at -O0. A parameter
    // is assignable in BCC, so it needs somewhere to live; mem2reg takes the
    // copy back out in Part 8.
    const slot = builder.alloca(symbol, param.name.text, incoming.type, param.span)
    builder.store(slot, value(incoming.value), param.span)
  })

  const returnType = returnTypeOf(declaration, resolution, typeInfo)
  builder.block(declaration.body)

  return builder.finish(params, returnType)
}

function lowerTopLevel(
  statements: readonly Stmt[],
  span: Span,
  resolution: Resolution,
  typeInfo: TypeInfo
): IrFunction {
  const builder = createBuilder(TOP_LEVEL_FUNCTION, span, resolution, typeInfo)
  for (const statement of statements) builder.statement(statement)
  return builder.finish([], UNIT)
}

function returnTypeOf(
  declaration: FunctionDecl,
  resolution: Resolution,
  typeInfo: TypeInfo
): Type {
  const symbol = resolution.declarations.get(declaration.name)
  const signature = symbol === undefined ? undefined : typeInfo.symbolTypes.get(symbol)
  return signature?.kind === 'function' ? signature.result : UNIT
}

function createBuilder(
  name: string,
  span: Span,
  resolution: Resolution,
  typeInfo: TypeInfo
) {
  const blocks: PendingBlock[] = []
  /** Every variable's slot. Keyed by symbol, so shadowing resolves correctly. */
  const slots = new Map<SymbolInfo, ValueId>()

  let nextValueId = 0
  let currentId: BlockId

  const newBlock = (base: string): BlockId => {
    const id = blocks.length
    blocks.push({ id, base, instructions: [], terminator: null })
    return id
  }

  const current = (): PendingBlock => {
    const block = blocks[currentId]
    if (block === undefined) throw new Error('no current block')
    return block
  }

  /** True once this block has been ended; further statements cannot run. */
  const terminated = (): boolean => current().terminator !== null

  const emit = (instruction: Instruction): void => {
    if (terminated()) return
    current().instructions.push(instruction)
  }

  const end = (terminator: Terminator): void => {
    if (terminated()) return
    current().terminator = terminator
  }

  const nextValue = (): ValueId => nextValueId++

  const alloca = (symbol: SymbolInfo, label: string, type: Type, at: Span): ValueId => {
    const result = nextValue()
    // Allocas go in the ENTRY block rather than where the `let` is written, so
    // a `let` inside a loop does not allocate a fresh slot on every iteration.
    // The same reason LLVM's mem2reg only looks at entry-block allocas.
    blocks[0]?.instructions.push({ op: 'alloca', result, name: label, type, span: at })
    slots.set(symbol, result)
    return result
  }

  const store = (slot: ValueId, operand: Operand, at: Span): void => {
    emit({ op: 'store', slot, value: operand, span: at })
  }

  const load = (slot: ValueId, at: Span): Operand => {
    const result = nextValue()
    emit({ op: 'load', result, slot, span: at })
    return value(result)
  }

  /** A scratch slot with no source variable behind it — for `&&` and `||`. */
  const temporary = (label: string, type: Type, at: Span): ValueId => {
    const result = nextValue()
    blocks[0]?.instructions.push({ op: 'alloca', result, name: label, type, span: at })
    return result
  }

  const typeOf = (expr: Expr): Type => typeInfo.types.get(expr) ?? ERROR

  /* ------------------------------ expressions ---------------------------- */

  const expression = (expr: Expr): Operand => {
    switch (expr.kind) {
      case 'Int':
        return constant(expr.value)

      case 'Bool':
        return constant(expr.value)

      case 'ErrorExpr':
        // The parser and the checker have both already reported this. A zero
        // keeps the IR well-formed so the rest of the function still lowers,
        // which is what lets the Observatory show a broken file.
        return constant(0)

      case 'Name': {
        const symbol = resolution.uses.get(expr)
        const slot = symbol === undefined ? undefined : slots.get(symbol)
        if (slot === undefined) return constant(0)
        return load(slot, expr.span)
      }

      case 'Unary': {
        const operand = expression(expr.operand)
        const result = nextValue()
        emit({
          op: 'unary',
          result,
          operator: expr.operator,
          operand,
          span: expr.span
        })
        return value(result)
      }

      case 'Binary': {
        const left = expression(expr.left)
        const right = expression(expr.right)
        const result = nextValue()
        emit({
          op: 'binary',
          result,
          operator: expr.operator,
          left,
          right,
          span: expr.span
        })
        return value(result)
      }

      case 'Logical':
        return logical(expr)

      case 'Call': {
        // The callee is always a plain name: the type checker rejects function
        // values, so there is no indirect call to lower and no case to guess at.
        const callee = expr.callee.kind === 'Name' ? expr.callee.text : ''
        const args = expr.args.map(expression)
        const resultType = typeOf(expr)
        const result = resultType.kind === 'unit' ? null : nextValue()
        emit({ op: 'call', result, callee, args, span: expr.span })
        return result === null ? constant(0) : value(result)
      }
    }
  }

  /**
   * `a && b` and `a || b`, as control flow.
   *
   * The right side must not be evaluated when the left already decides the
   * answer — that is the whole meaning of the operator, and an instruction that
   * took two operands would have evaluated both by the time it ran.
   *
   * The result goes through a slot rather than a phi because phis do not exist
   * until Part 6. That is not a workaround: it is the same memory-shaped
   * lowering every local gets, and watching mem2reg replace it with a phi is
   * one of the clearest demonstrations the Observatory will have.
   */
  const logical = (expr: Extract<Expr, { kind: 'Logical' }>): Operand => {
    const slot = temporary(expr.operator === '&&' ? 'and' : 'or', typeOf(expr), expr.span)

    const left = expression(expr.left)
    store(slot, left, expr.left.span)

    const rhs = newBlock(expr.operator === '&&' ? 'and.rhs' : 'or.rhs')
    const join = newBlock(expr.operator === '&&' ? 'and.join' : 'or.join')

    // `&&` evaluates the right side when the left is TRUE; `||` when it is
    // false. Everything else about the two is identical.
    end(
      expr.operator === '&&'
        ? { op: 'branch', condition: left, ifTrue: rhs, ifFalse: join, span: expr.span }
        : { op: 'branch', condition: left, ifTrue: join, ifFalse: rhs, span: expr.span }
    )

    currentId = rhs
    const right = expression(expr.right)
    store(slot, right, expr.right.span)
    end({ op: 'jump', target: join, span: expr.span })

    currentId = join
    return load(slot, expr.span)
  }

  /* ------------------------------- statements ---------------------------- */

  const block = (body: BlockStmt): void => {
    for (const statement of body.statements) statement_(statement)
  }

  const statement_ = (node: Stmt): void => {
    // Anything after a terminator cannot run. Dropped rather than emitted into
    // an unreachable block; see the note at the top of the file.
    if (terminated()) return

    switch (node.kind) {
      case 'Let': {
        const symbol = resolution.declarations.get(node.name)
        const type = symbol === undefined ? ERROR : (typeInfo.symbolTypes.get(symbol) ?? ERROR)
        const initializer = expression(node.initializer)
        if (symbol === undefined) return
        const slot = alloca(symbol, node.name.text, type, node.span)
        store(slot, initializer, node.span)
        return
      }

      case 'Assign': {
        const operand = expression(node.value)
        const symbol = resolution.stores.get(node.target)
        const slot = symbol === undefined ? undefined : slots.get(symbol)
        if (slot === undefined) return
        store(slot, operand, node.span)
        return
      }

      case 'If': {
        const condition = expression(node.condition)
        const thenId = newBlock('then')
        const elseId = node.elseBranch === null ? null : newBlock('else')
        const joinId = newBlock('join')

        end({
          op: 'branch',
          condition,
          ifTrue: thenId,
          ifFalse: elseId ?? joinId,
          span: node.span
        })

        currentId = thenId
        block(node.thenBranch)
        end({ op: 'jump', target: joinId, span: node.span })

        if (elseId !== null && node.elseBranch !== null) {
          currentId = elseId
          if (node.elseBranch.kind === 'Block') block(node.elseBranch)
          else statement_(node.elseBranch)
          end({ op: 'jump', target: joinId, span: node.span })
        }

        currentId = joinId
        return
      }

      case 'While': {
        // The condition gets its OWN block. It has to be re-evaluated on every
        // iteration, so it cannot live in the block that precedes the loop —
        // and giving it a block is also what makes the back edge visible, which
        // is what Part 6's dominance calculation walks.
        const headId = newBlock('while.head')
        const bodyId = newBlock('while.body')
        const exitId = newBlock('while.exit')

        end({ op: 'jump', target: headId, span: node.span })

        currentId = headId
        const condition = expression(node.condition)
        end({
          op: 'branch',
          condition,
          ifTrue: bodyId,
          ifFalse: exitId,
          span: node.span
        })

        currentId = bodyId
        block(node.body)
        end({ op: 'jump', target: headId, span: node.span })

        currentId = exitId
        return
      }

      case 'Return': {
        const operand = node.value === null ? null : expression(node.value)
        end({ op: 'return', value: operand, span: node.span })
        return
      }

      case 'Print': {
        const operand = expression(node.value)
        emit({ op: 'print', value: operand, span: node.span })
        return
      }

      case 'ExprStmt':
        expression(node.expression)
        return

      case 'Block':
        block(node)
        return

      case 'Function':
        // Nested functions are rejected by the resolver. Nothing to lower, and
        // lowering them into the enclosing function would be wrong.
        return

      case 'ErrorStmt':
        return
    }
  }

  const finish = (params: readonly IrParam[], result: Type): IrFunction => {
    // Any block still open at the end falls off the end of the function. For a
    // unit function that is an ordinary return; for one that promised a value
    // the checker has already reported BCC0016, and `unreachable` says which of
    // the two this is rather than inventing a value.
    const sealed = blocks.map((pending) => ({
      id: pending.id,
      base: pending.base,
      instructions: pending.instructions,
      terminator:
        pending.terminator ??
        (result.kind === 'unit' || result.kind === 'error'
          ? ({ op: 'return', value: null, span } as Terminator)
          : ({ op: 'unreachable', span } as Terminator))
    }))

    /*
     * Blocks nothing reaches are dropped, and the rest are renumbered.
     *
     * The lowering creates a join for every `if` before it knows whether either
     * branch will reach it, so `if c { return 1; } else { return 2; }` leaves a
     * join with no predecessors. Shipping it would put a box in the Observatory
     * that no path enters and give Part 6 a block with no dominator to compute.
     *
     * This is not a substitute for Part 8's dead-code elimination, which is
     * about dead INSTRUCTIONS — values computed and never used. This only
     * removes blocks the lowering itself made unnecessary.
     *
     * Ids stay contiguous from zero, and labels take their number from the
     * final id, so `join.3` becoming block 2 reads as `join.2` rather than
     * keeping a number that now points at a different block.
     */
    const byId = new Map(sealed.map((block) => [block.id, block]))
    const reachable = new Set<BlockId>()
    const stack: BlockId[] = [0]
    while (stack.length > 0) {
      const id = stack.pop()
      if (id === undefined || reachable.has(id)) continue
      reachable.add(id)
      const block = byId.get(id)
      if (block === undefined) continue
      for (const successor of successorsOf(block.terminator)) stack.push(successor)
    }

    const kept = sealed.filter((block) => reachable.has(block.id))
    const renumbered = new Map<BlockId, BlockId>(
      kept.map((block, index) => [block.id, index])
    )
    const to = (id: BlockId): BlockId => renumbered.get(id) ?? 0

    const finished: Block[] = kept.map((block, index) => ({
      id: index,
      label: `${block.base}.${index}`,
      instructions: block.instructions,
      terminator: retarget(block.terminator, to)
    }))

    return { name, params, returnType: result, blocks: finished, entry: 0, span }
  }

  currentId = newBlock('entry')

  return { nextValue, alloca, store, block, statement: statement_, finish }
}
