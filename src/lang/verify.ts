import { computeDominance } from './dominance'
import {
  definitionOf,
  predecessorsOf,
  successorsOf,
  terminatorUses,
  usesOf,
  type BlockId,
  type IrFunction,
  type Module,
  type ValueId
} from './ir'

/**
 * Is this IR well-formed?
 *
 * ## Why this exists
 *
 * Part 8 rewrites the IR four times per function, and a pass that produces
 * subtly broken IR does not fail where it was written — it fails in the VM,
 * three stages later, as a wrong answer. This is what turns that into a failure
 * at the pass that caused it, and it is the single thing that makes optimisation
 * passes safe to write alone.
 *
 * So it runs after EVERY pass, not once at the end. A verifier that only runs at
 * the end tells you the IR is broken; a verifier that runs after each pass tells
 * you which pass broke it.
 *
 * ## It is deliberately independent
 *
 * It shares no code with the thing it checks. `lower.ts` and `ssa.ts` compute
 * dominance to DECIDE what to build; this recomputes it to CHECK what was built.
 * If it reused their bookkeeping it would agree with their mistakes, which is the
 * one failure mode a verifier cannot have.
 *
 * The SSA checks that lived in `ssa.ts` are folded in here, for the same reason
 * `symbols.ts` builds the scope tree rather than letting a second pass rebuild
 * it: two implementations of one rule are two chances to disagree.
 *
 * ## It never throws
 *
 * The verifier is what you reach for when you already suspect the IR is broken.
 * Crashing on malformed input is the one behaviour that would make it useless
 * exactly when it is needed, so every lookup tolerates a miss and every rule
 * reports rather than assumes.
 *
 * ## One problem, one violation
 *
 * An unreachable block has no dominator, so every use inside it would otherwise
 * report "definition does not dominate" as well. Blocks that fail a structural
 * rule are excluded from the rules that depend on that structure — the same
 * poisoning discipline the type checker uses to keep one mistake to one message.
 */

export type VerificationRule =
  // Structure
  | 'missing-entry-block'
  | 'duplicate-block-id'
  | 'missing-successor'
  | 'entry-has-predecessors'
  | 'unreachable-block'
  // Values
  | 'duplicate-definition'
  | 'undefined-value'
  | 'use-before-definition'
  | 'definition-does-not-dominate'
  // Phis
  | 'phi-not-at-block-start'
  | 'phi-in-entry-block'
  | 'phi-arity-mismatch'
  | 'phi-predecessor-mismatch'
  | 'phi-operand-does-not-dominate'
  // Memory
  | 'slot-is-not-an-alloca'
  // Signatures
  | 'return-value-mismatch'
  | 'unknown-callee'
  | 'call-arity-mismatch'
  | 'duplicate-function-name'

/**
 * What each rule means, one line each.
 *
 * A total `Record`, so a rule added without a description is a compile error —
 * the same trick `DIAGNOSTIC_TITLES` and `ipc-contract.ts` use. It also makes
 * the rule set enumerable, which is what lets a test assert every rule is
 * exercised rather than listing them by hand.
 */
export const VERIFICATION_RULES: Readonly<Record<VerificationRule, string>> = {
  'missing-entry-block': 'the entry block id names no block',
  'duplicate-block-id': 'two blocks share an id',
  'missing-successor': 'a terminator names a block that does not exist',
  'entry-has-predecessors': 'something branches back to the entry block',
  'unreachable-block': 'no path from the entry reaches this block',
  'duplicate-definition': 'a value is defined more than once',
  'undefined-value': 'a value is used that nothing defines',
  'use-before-definition': 'a value is used earlier in its own block than it is defined',
  'definition-does-not-dominate': 'a value is used where its definition does not reach',
  'phi-not-at-block-start': 'a phi appears after an ordinary instruction',
  'phi-in-entry-block': 'the entry block has a phi, but nothing branches to it',
  'phi-arity-mismatch': 'a phi has a different number of arguments than incoming edges',
  'phi-predecessor-mismatch': 'a phi argument names a block that is not that edge',
  'phi-operand-does-not-dominate': 'a phi argument does not reach the edge it comes in on',
  'slot-is-not-an-alloca': 'a load or store addresses something that is not a slot',
  'return-value-mismatch': 'a return disagrees with the function it returns from',
  'unknown-callee': 'a call names a function the module does not contain',
  'call-arity-mismatch': 'a call passes a different number of arguments than the callee takes',
  'duplicate-function-name': 'two functions in the module share a name'
}

export interface Violation {
  readonly rule: VerificationRule
  /** For a human, naming the specific values or blocks involved. */
  readonly message: string
  readonly fn: string
  /** The block it was found in, when the rule is about one. */
  readonly block: string | null
}

/* -------------------------------------------------------------------------- */
/*  One function                                                               */
/* -------------------------------------------------------------------------- */

export function verifyFunction(fn: IrFunction): Violation[] {
  const violations: Violation[] = []
  const report = (rule: VerificationRule, message: string, block: string | null = null): void => {
    violations.push({ rule, message, fn: fn.name, block })
  }

  /* ------------------------------ structure ------------------------------ */

  const byId = new Map<BlockId, (typeof fn.blocks)[number]>()
  for (const block of fn.blocks) {
    if (byId.has(block.id)) {
      report('duplicate-block-id', `two blocks are numbered ${block.id}`, block.label)
      continue
    }
    byId.set(block.id, block)
  }

  const entry = byId.get(fn.entry)
  if (entry === undefined) {
    // Everything below is computed from the entry, so nothing after this would
    // mean anything. One violation is more useful than fifty derived from it.
    report('missing-entry-block', `the entry is block ${fn.entry}, which does not exist`)
    return violations
  }

  const labelOf = (id: BlockId): string => byId.get(id)?.label ?? `block ${id}`

  for (const block of fn.blocks) {
    for (const successor of successorsOf(block.terminator)) {
      if (byId.has(successor)) continue
      report('missing-successor', `jumps to block ${successor}, which does not exist`, block.label)
    }
  }

  const predecessors = predecessorsOf(fn)

  // Nothing may branch back to the entry. Parameters are defined "on entry"
  // before instruction zero, and a second way in would mean they too needed a
  // phi — so every later stage's assumption about parameters rests on this.
  const entryPredecessors = predecessors.get(fn.entry) ?? []
  if (entryPredecessors.length > 0) {
    report(
      'entry-has-predecessors',
      `${entryPredecessors.map(labelOf).join(', ')} branch to the entry block`,
      entry.label
    )
  }

  const dominance = computeDominance(fn)

  /*
   * Unreachable blocks are reported once and then excluded.
   *
   * They have no dominator — there is no path to them to dominate — so every
   * use inside one would otherwise also report "definition does not dominate",
   * burying the real problem under its own consequences.
   */
  const live = new Set<BlockId>()
  for (const block of fn.blocks) {
    if (dominance.reachable.has(block.id)) {
      live.add(block.id)
      continue
    }
    report('unreachable-block', 'nothing branches here', block.label)
  }

  /* ------------------------------- values -------------------------------- */

  /** Where each value is defined: its block, and its index within that block. */
  const definedAt = new Map<ValueId, { block: BlockId; index: number }>()
  /** Values produced by an `alloca`, for the load/store rule. */
  const slots = new Set<ValueId>()

  for (const param of fn.params) {
    if (definedAt.has(param.value)) {
      report('duplicate-definition', `%${param.value} is a parameter twice over`)
      continue
    }
    // Before instruction zero of the entry, which is what makes a parameter
    // dominate every block.
    definedAt.set(param.value, { block: fn.entry, index: -1 })
  }

  for (const block of fn.blocks) {
    block.instructions.forEach((instruction, index) => {
      if (instruction.op === 'alloca') slots.add(instruction.result)

      const defined = definitionOf(instruction)
      if (defined === null) return
      if (definedAt.has(defined)) {
        report('duplicate-definition', `%${defined} is defined again here`, block.label)
        return
      }
      definedAt.set(defined, { block: block.id, index })
    })
  }

  /**
   * Is `used` available at instruction `index` of `block`?
   *
   * Reports at most one violation per use: undefined, or too early in its own
   * block, or defined somewhere that does not reach here — never two of them.
   */
  const checkUse = (
    used: ValueId,
    block: BlockId,
    blockLabel: string,
    index: number,
    what: string
  ): void => {
    const definition = definedAt.get(used)
    if (definition === undefined) {
      report('undefined-value', `${what} reads %${used}, which nothing defines`, blockLabel)
      return
    }

    if (definition.block === block) {
      if (definition.index >= index) {
        report(
          'use-before-definition',
          `${what} reads %${used}, which is defined further down this block`,
          blockLabel
        )
      }
      return
    }

    if (!dominance.dominates(definition.block, block)) {
      report(
        'definition-does-not-dominate',
        `${what} reads %${used}, defined in ${labelOf(definition.block)}, which does not reach here`,
        blockLabel
      )
    }
  }

  for (const block of fn.blocks) {
    if (!live.has(block.id)) continue

    const edges = predecessors.get(block.id) ?? []
    let seenOrdinary = false

    block.instructions.forEach((instruction, index) => {
      if (instruction.op === 'phi') {
        if (seenOrdinary) {
          report(
            'phi-not-at-block-start',
            `%${instruction.result} is a phi after an ordinary instruction`,
            block.label
          )
        }

        if (block.id === fn.entry) {
          report(
            'phi-in-entry-block',
            `%${instruction.result} is a phi in the entry block, which has no incoming edges`,
            block.label
          )
        }

        if (instruction.incoming.length !== edges.length) {
          report(
            'phi-arity-mismatch',
            `%${instruction.result} has ${instruction.incoming.length} argument${instruction.incoming.length === 1 ? '' : 's'} for ${edges.length} incoming edge${edges.length === 1 ? '' : 's'}`,
            block.label
          )
        }

        instruction.incoming.forEach((edge, edgeIndex) => {
          const expected = edges[edgeIndex]
          if (expected !== undefined && edge.from !== expected) {
            report(
              'phi-predecessor-mismatch',
              `%${instruction.result} argument ${edgeIndex} says it comes from ${labelOf(edge.from)}, but that edge comes from ${labelOf(expected)}`,
              block.label
            )
            return
          }
          if (edge.value.kind !== 'value') return

          const definition = definedAt.get(edge.value.id)
          if (definition === undefined) {
            report(
              'undefined-value',
              `%${instruction.result} reads %${edge.value.id}, which nothing defines`,
              block.label
            )
            return
          }

          /*
           * Checked against the PREDECESSOR, not against this block.
           *
           * This is the rule most SSA bugs break. A value computed in one arm of
           * a diamond does not dominate the join — that is exactly why the phi is
           * there — so checking it against the join would reject correct code.
           * Checking it too loosely would accept a value that is not available
           * on that edge, which is the same bug wearing a disguise.
           */
          if (!dominance.dominates(definition.block, edge.from)) {
            report(
              'phi-operand-does-not-dominate',
              `%${instruction.result} takes %${edge.value.id} from ${labelOf(edge.from)}, but it is not available on that edge`,
              block.label
            )
          }
        })
        return
      }

      seenOrdinary = true

      for (const used of usesOf(instruction)) {
        checkUse(used, block.id, block.label, index, `${instruction.op}`)
      }

      // A load or store must address a slot. Anything else means an ordinary
      // value is being treated as an address, which the language has no way to
      // express and no way to execute.
      if (instruction.op === 'load' || instruction.op === 'store') {
        if (definedAt.has(instruction.slot) && !slots.has(instruction.slot)) {
          report(
            'slot-is-not-an-alloca',
            `${instruction.op} addresses %${instruction.slot}, which is not a slot`,
            block.label
          )
        }
      }
    })

    for (const used of terminatorUses(block.terminator)) {
      checkUse(used, block.id, block.label, block.instructions.length, 'the terminator')
    }

    // `unreachable` makes no promise about a value, so it is exempt.
    if (block.terminator.op === 'return' && fn.returnType.kind !== 'error') {
      const returnsNothing = fn.returnType.kind === 'unit'
      if (returnsNothing && block.terminator.value !== null) {
        report('return-value-mismatch', 'returns a value from a unit function', block.label)
      }
      if (!returnsNothing && block.terminator.value === null) {
        report(
          'return-value-mismatch',
          `returns nothing from a function that returns ${fn.returnType.kind}`,
          block.label
        )
      }
    }
  }

  return violations
}

/* -------------------------------------------------------------------------- */
/*  A whole module                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Every function, plus the rules that only make sense across them.
 *
 * A call's callee is a NAME rather than a value — BCC has no function values —
 * so whether it resolves is a question about the module, not about the function
 * containing the call. Nothing inside `verifyFunction` could answer it.
 */
export function verifyModule(module: Module): Violation[] {
  const violations: Violation[] = []

  /*
   * Names must be unique, because a call names one.
   *
   * `fn f() {} fn f() {}` is reported by the resolver as BCC0009, but lowering
   * emits BOTH — so the module really does contain two functions called `f` and
   * `call f()` has no single meaning. Part 9's VM would have to pick one
   * arbitrarily, which is the kind of decision that turns into a bug report
   * about the wrong function running.
   *
   * The verifier answers a question about the IR, not about the source, so it
   * reports this whether or not the front end already complained. A Part 8 pass
   * that clones a function would introduce the same fault with no front end
   * involved at all.
   */
  const signatures = new Map<string, number>()
  for (const fn of module.functions) {
    if (signatures.has(fn.name)) {
      violations.push({
        rule: 'duplicate-function-name',
        message: `a second function is also called '${fn.name}'`,
        fn: fn.name,
        block: null
      })
      continue
    }
    // First one wins, so arity checks below are at least deterministic.
    signatures.set(fn.name, fn.params.length)
  }

  for (const fn of module.functions) {
    violations.push(...verifyFunction(fn))

    for (const block of fn.blocks) {
      for (const instruction of block.instructions) {
        if (instruction.op !== 'call') continue

        const arity = signatures.get(instruction.callee)
        if (arity === undefined) {
          violations.push({
            rule: 'unknown-callee',
            message: `calls '${instruction.callee}', which this module does not define`,
            fn: fn.name,
            block: block.label
          })
          continue
        }

        if (instruction.args.length !== arity) {
          violations.push({
            rule: 'call-arity-mismatch',
            message: `calls '${instruction.callee}' with ${instruction.args.length} argument${instruction.args.length === 1 ? '' : 's'}, but it takes ${arity}`,
            fn: fn.name,
            block: block.label
          })
        }
      }
    }
  }

  return violations
}

/** One line per violation, for a pass manager's failure message. */
export function describeViolations(violations: readonly Violation[]): string {
  return violations
    .map((violation) => {
      const where = violation.block === null ? violation.fn : `${violation.fn}:${violation.block}`
      return `${where}: ${violation.message} [${violation.rule}]`
    })
    .join('\n')
}
