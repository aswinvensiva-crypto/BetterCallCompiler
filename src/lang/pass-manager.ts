import { printFunction, type IrFunction, type Module } from './ir'
import { describeViolations, verifyModule, type Violation } from './verify'

/**
 * Running optimisation passes, and refusing to run them unsafely.
 *
 * Part 7 built a verifier and nothing imported it. This is the module that
 * makes it earn its keep: every pass is checked the moment it finishes, so a
 * pass that breaks the IR is named by the pass that broke it rather than by
 * whatever stage first trips over the damage. Without that, a mem2reg bug
 * surfaces in Part 9's VM as a wrong number, three stages and several hundred
 * lines away from its cause. That distance is the single biggest reason writing
 * optimisation passes solo is usually a bad idea, and closing it is the whole
 * point of the ordering the plan chose.
 *
 * ## The pipeline stops; it does not throw
 *
 * A broken pass halts the pipeline and the report says which one and why. It
 * would be easier to throw, and it would be wrong: this runs inside a daemon
 * that also serves squiggles, and a pass bug would take the language server
 * down with it. Halting hands back the last IR that verified, so the Observatory
 * and the VM still have something well-formed to read, and the failure is a
 * value the UI can render rather than an exception someone has to catch.
 *
 * ## The input is verified first, once
 *
 * Otherwise the first pass gets blamed for damage that lowering did. That has
 * already happened once in this codebase's history — Part 7's commit message
 * records the verifier finding a bug in Part 5 on its first run — and a pass
 * manager that could not tell those two cases apart would have sent the reader
 * hunting in the wrong file.
 */

/* -------------------------------------------------------------------------- */
/*  What a pass is                                                             */
/* -------------------------------------------------------------------------- */

/**
 * One function, rewritten.
 *
 * A pass returns new IR rather than mutating: the Observatory shows before and
 * after side by side, so both have to exist at once. It is also what makes a
 * failed pass recoverable — the previous module is still intact, because
 * nothing edited it in place.
 */
export interface PassResult {
  readonly fn: IrFunction
  /**
   * What the pass did, one short line each — `folded 3 binary instructions`.
   *
   * Empty means it found nothing to do. This is for a human reading the
   * Observatory, not a machine: `changed` is computed from the IR itself
   * below, so a pass that forgot to write a note cannot make a real change
   * invisible.
   */
  readonly notes: readonly string[]
}

export interface Pass {
  /** Stable, lowercase, hyphenated. Used as a record key and in the UI. */
  readonly name: string
  /** One line: what it does and what it teaches. */
  readonly summary: string
  run(fn: IrFunction): PassResult
}

/* -------------------------------------------------------------------------- */
/*  What running one produced                                                  */
/* -------------------------------------------------------------------------- */

/** One pass, applied to one function. */
export interface PassOutcome {
  readonly pass: string
  readonly fn: string
  /** Content hash before, so the Observatory can key a diff on it. */
  readonly before: string
  readonly after: string
  /**
   * The actual IR before and after, for the Observatory's Passes tab to show
   * side by side WITH working click-to-source — a plain text field could not
   * carry the spans each line needs. `before`/`after` above stay content
   * hashes rather than being derived from these on every comparison, because
   * `changed` and the golden tests want a cheap, printed-text-shaped identity
   * and have no use for a full object graph.
   */
  readonly beforeFn: IrFunction
  readonly afterFn: IrFunction
  /**
   * Whether the IR actually moved.
   *
   * Computed by comparing the canonical form, NOT by trusting the pass to say
   * so and NOT by comparing the hashes. A hash comparison would report a
   * collision as "unchanged", and "unchanged" is the answer that stops work —
   * so the one direction a collision could break is exactly the one that
   * matters. Comparing the strings costs the same walk and cannot be wrong.
   */
  readonly changed: boolean
  readonly notes: readonly string[]
}

/** The pass that broke the IR, and how. */
export interface PassFailure {
  /** Null when the INPUT was already malformed — then no pass is to blame. */
  readonly pass: string | null
  readonly violations: readonly Violation[]
  readonly message: string
}

export interface PipelineReport {
  /**
   * The IR to use. On failure this is the last module that verified, which is
   * the input itself when the very first pass broke it.
   */
  readonly module: Module
  readonly outcomes: readonly PassOutcome[]
  /** Null when every pass verified. */
  readonly failure: PassFailure | null
}

/* -------------------------------------------------------------------------- */
/*  Content hashing                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The canonical text a hash is taken over.
 *
 * `printFunction` alone is not quite enough. It prints block LABELS, which
 * `ir.ts` documents as "for reading, not for identity" — a pass that split a
 * block could give two blocks the same label, and two different graphs would
 * then print identically. Prefixing the id-to-label map makes the form
 * unambiguous again for a cost of one line per block.
 *
 * Exported because the golden tests compare it and the Observatory will show
 * it, and because a hash whose input is private is a hash nobody can debug.
 */
export function canonicalForm(fn: IrFunction): string {
  const blocks = fn.blocks.map((block) => `${block.id}=${block.label}`).join(',')
  return `[${blocks}]\n${printFunction(fn)}`
}

/**
 * cyrb53, a 53-bit string hash.
 *
 * Pure arithmetic, because `src/lang` may not import node — no `crypto`, and
 * this has to run in the worker and in the renderer alike. 53 bits is far more
 * than this needs: a function has a handful of revisions in a session, not
 * billions, and nothing security-relevant keys on it.
 *
 * It is an identifier for a revision, never a truth test. `changed` above is
 * decided by comparing the canonical forms directly for exactly that reason.
 */
export function contentHash(fn: IrFunction): string {
  const text = canonicalForm(fn)
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57

  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)

  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/* -------------------------------------------------------------------------- */
/*  Running them                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Run every pass over every function, verifying between each.
 *
 * Passes are function-local — none of the four in Part 8 looks outside the one
 * it is given — but verification is done on the whole MODULE after each pass.
 * That costs one extra walk and catches the rules a function cannot check
 * alone: a call whose arity no longer matches, a callee that is gone. A
 * function-only check would declare each function individually fine while the
 * module they form had stopped making sense.
 */
export function runPipeline(module: Module, passes: readonly Pass[]): PipelineReport {
  const inputViolations = verifyModule(module)
  if (inputViolations.length > 0) {
    return {
      module,
      outcomes: [],
      failure: {
        // No pass has run, so no pass is at fault. Saying `null` here rather
        // than naming the first pass is what stops a reader debugging a pass
        // that is innocent.
        pass: null,
        violations: inputViolations,
        message: `the IR was already malformed before any pass ran:\n${describeViolations(inputViolations)}`
      }
    }
  }

  const outcomes: PassOutcome[] = []
  let current = module

  for (const pass of passes) {
    const functions: IrFunction[] = []
    const round: PassOutcome[] = []

    for (const fn of current.functions) {
      const before = canonicalForm(fn)
      const result = pass.run(fn)
      const after = canonicalForm(result.fn)

      functions.push(result.fn)
      round.push({
        pass: pass.name,
        fn: fn.name,
        before: contentHash(fn),
        after: contentHash(result.fn),
        beforeFn: fn,
        afterFn: result.fn,
        changed: before !== after,
        notes: result.notes
      })
    }

    const next: Module = { functions }
    const violations = verifyModule(next)

    if (violations.length > 0) {
      // `current`, not `next`: the caller gets the last IR that verified. The
      // outcomes for this round are dropped too — they describe a module that
      // is not being returned, and reporting them beside a rolled-back module
      // would show the Observatory a diff against IR nobody holds.
      return {
        module: current,
        outcomes,
        failure: {
          pass: pass.name,
          violations,
          message: `${pass.name} produced invalid IR:\n${describeViolations(violations)}`
        }
      }
    }

    outcomes.push(...round)
    current = next
  }

  return { module: current, outcomes, failure: null }
}

/**
 * Whether a pipeline moved anything, for the "nothing to show" case.
 *
 * A pass that ran and changed nothing is still worth a row in the Observatory —
 * "constant folding: no change" is information — so this is about the pipeline
 * as a whole, not about suppressing individual outcomes.
 */
export function pipelineChangedAnything(report: PipelineReport): boolean {
  return report.outcomes.some((outcome) => outcome.changed)
}
