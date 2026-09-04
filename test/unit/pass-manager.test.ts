import { describe, expect, it } from 'vitest'
import { parseSource } from '../../src/lang/parser'
import { resolve } from '../../src/lang/symbols'
import { typeCheck } from '../../src/lang/type-check'
import { lower } from '../../src/lang/lower'
import { constant, type Block, type IrFunction, type Module } from '../../src/lang/ir'
import {
  canonicalForm,
  contentHash,
  pipelineChangedAnything,
  runPipeline,
  type Pass
} from '../../src/lang/pass-manager'
import type { Span } from '../../src/lang/token'

/**
 * The pass manager, tested on what it is FOR rather than on what it does.
 *
 * What it does is call four functions in a row, which is not worth a test. What
 * it is for is refusing to hand on IR a pass has broken, attributing the break
 * to the pass that caused it, and keeping the last good module so the rest of
 * the compiler still has something to read. Every test below is one of those
 * three, plus the bookkeeping the Observatory will render.
 *
 * The passes here are fixtures, deliberately. Testing the manager against a
 * real optimisation would mean a failure could be either one's fault, and the
 * whole point of this module is telling those two apart.
 */

const SPAN: Span = {
  offset: 0,
  length: 0,
  startLine: 1,
  startColumn: 1,
  endLine: 1,
  endColumn: 1
}

function moduleFor(source: string): Module {
  const { program, diagnostics } = parseSource(source)
  expect(diagnostics, `parse errors in ${JSON.stringify(source)}`).toEqual([])
  const resolution = resolve(program)
  return lower(program, resolution, typeCheck(program, resolution))
}

/** Does nothing at all, and says so. */
const identity: Pass = {
  name: 'identity',
  summary: 'returns its input unchanged',
  run: (fn) => ({ fn, notes: [] })
}

/**
 * Renames every block, which changes the printed IR and nothing else.
 *
 * A pass that is observably different but semantically identical — exactly the
 * case where trusting a pass's own `changed` claim and computing it from the IR
 * can disagree.
 */
const relabel: Pass = {
  name: 'relabel',
  summary: 'renames blocks without touching the graph',
  run: (fn) => ({
    fn: { ...fn, blocks: fn.blocks.map((block) => ({ ...block, label: `r.${block.label}` })) },
    notes: [`relabelled ${fn.blocks.length} blocks`]
  })
}

/**
 * Points the entry's terminator at a block that does not exist.
 *
 * The smallest possible way to break the IR, and one the verifier catches as
 * `missing-successor`. A real pass breaks itself in more interesting ways; this
 * one exists so the test asserts the GATE, not a particular bug.
 */
const breaksTheGraph: Pass = {
  name: 'breaks-the-graph',
  summary: 'jumps to a block that is not there',
  run: (fn) => {
    const blocks: Block[] = fn.blocks.map((block, index) =>
      index === 0 ? { ...block, terminator: { op: 'jump', target: 9999, span: SPAN } } : block
    )
    return { fn: { ...fn, blocks }, notes: ['pointed the entry somewhere silly'] }
  }
}

/** Defines the same value twice — a violation only a dataflow check finds. */
const duplicatesADefinition: Pass = {
  name: 'duplicates-a-definition',
  summary: 'defines one value in two places',
  run: (fn) => {
    const [first, ...rest] = fn.blocks
    if (first === undefined) return { fn, notes: [] }
    const duplicated: Block = {
      ...first,
      instructions: [
        ...first.instructions,
        { op: 'binary', result: 0, operator: '+', left: constant(1), right: constant(1), span: SPAN },
        { op: 'binary', result: 0, operator: '+', left: constant(1), right: constant(1), span: SPAN }
      ]
    }
    return { fn: { ...fn, blocks: [duplicated, ...rest] }, notes: [] }
  }
}

describe('a clean run', () => {
  it('reports one outcome per pass per function', () => {
    const module = moduleFor('fn a() { }\nfn b() { }\na();')
    const report = runPipeline(module, [identity, relabel])

    expect(report.failure).toBeNull()
    // Two passes over three functions — `a`, `b` and the synthesised top level.
    expect(report.outcomes).toHaveLength(2 * module.functions.length)
    expect(report.outcomes.map((outcome) => outcome.pass)).toEqual([
      ...module.functions.map(() => 'identity'),
      ...module.functions.map(() => 'relabel')
    ])
  })

  it('computes `changed` from the IR, not from what the pass claims', () => {
    const module = moduleFor('print 1;')

    // `identity` returns its input and writes no note; `relabel` writes a note
    // and genuinely moves the text. Neither is asked whether it changed
    // anything — the manager compares the canonical forms itself.
    const [unchanged] = runPipeline(module, [identity]).outcomes
    const [changed] = runPipeline(module, [relabel]).outcomes

    expect(unchanged?.changed).toBe(false)
    expect(changed?.changed).toBe(true)
  })

  it('carries each pass\'s notes through for the Observatory', () => {
    const report = runPipeline(moduleFor('print 1;'), [relabel])
    expect(report.outcomes[0]?.notes[0]).toMatch(/^relabelled \d+ blocks$/)
  })

  it('hashes before and after, and they differ exactly when the IR did', () => {
    const module = moduleFor('print 1;')
    const [same] = runPipeline(module, [identity]).outcomes
    const [moved] = runPipeline(module, [relabel]).outcomes

    expect(same?.before).toBe(same?.after)
    expect(moved?.before).not.toBe(moved?.after)
  })

  it('feeds each pass the output of the last one', () => {
    const report = runPipeline(moduleFor('print 1;'), [relabel, relabel])
    // Applied twice, so the labels carry two prefixes rather than one.
    expect(report.module.functions[0]?.blocks[0]?.label).toMatch(/^r\.r\./)
  })

  it('says whether anything moved at all', () => {
    const module = moduleFor('print 1;')
    expect(pipelineChangedAnything(runPipeline(module, [identity]))).toBe(false)
    expect(pipelineChangedAnything(runPipeline(module, [relabel]))).toBe(true)
  })
})

describe('the verifier gate', () => {
  /*
   * The reason this module exists. Each case asserts the same three things: the
   * pipeline stops, the failure names the pass that broke it, and the module
   * handed back is the last one that verified.
   */

  it('stops at the pass that broke the graph, and names it', () => {
    const module = moduleFor('print 1;')
    const report = runPipeline(module, [identity, breaksTheGraph, relabel])

    expect(report.failure?.pass).toBe('breaks-the-graph')
    expect(report.failure?.violations.map((v) => v.rule)).toContain('missing-successor')
  })

  it('catches a dataflow break, not only a structural one', () => {
    const report = runPipeline(moduleFor('print 1;'), [duplicatesADefinition])
    expect(report.failure?.pass).toBe('duplicates-a-definition')
    expect(report.failure?.violations.map((v) => v.rule)).toContain('duplicate-definition')
  })

  it('hands back the last module that verified, not the broken one', () => {
    const module = moduleFor('print 1;')
    const report = runPipeline(module, [relabel, breaksTheGraph])

    // `relabel` ran and verified, so its output is what survives — the caller
    // keeps the work that was good, and none of the work that was not.
    expect(report.module.functions[0]?.blocks[0]?.label).toMatch(/^r\./)
    expect(canonicalForm(report.module.functions[0] as IrFunction)).not.toContain('9999')
  })

  it('drops the outcomes of the round it rolled back', () => {
    const report = runPipeline(moduleFor('print 1;'), [identity, breaksTheGraph])

    // Reporting them would show the Observatory a diff against a module nobody
    // is holding.
    expect(report.outcomes.map((outcome) => outcome.pass)).toEqual(['identity'])
  })

  it('runs no pass after the one that failed', () => {
    const ran: string[] = []
    const record = (name: string): Pass => ({
      name,
      summary: 'records that it ran',
      run: (fn) => {
        ran.push(name)
        return { fn, notes: [] }
      }
    })

    runPipeline(moduleFor('print 1;'), [record('first'), breaksTheGraph, record('third')])
    expect(ran).toEqual(['first'])
  })

  it('blames no pass when the input was already malformed', () => {
    const module = moduleFor('print 1;')
    const broken: Module = {
      functions: module.functions.map((fn) => ({ ...fn, entry: 9999 }))
    }

    const report = runPipeline(broken, [identity])

    // `null`, not `'identity'`. Naming a pass that has not run yet sends the
    // reader hunting in the wrong file — and lowering has produced malformed
    // IR before, which is how Part 7 found a bug in Part 5.
    expect(report.failure?.pass).toBeNull()
    expect(report.failure?.violations.map((v) => v.rule)).toContain('missing-entry-block')
    expect(report.failure?.message).toContain('before any pass ran')
    expect(report.outcomes).toEqual([])
    expect(report.module).toBe(broken)
  })

  it('puts the rule and the location in the message a human reads', () => {
    const report = runPipeline(moduleFor('print 1;'), [breaksTheGraph])
    expect(report.failure?.message).toContain('breaks-the-graph produced invalid IR')
    expect(report.failure?.message).toContain('[missing-successor]')
  })
})

describe('content hashing', () => {
  it('is stable across calls on the same IR', () => {
    const fn = moduleFor('fn f(a: int) -> int { return a + 1; }').functions[0] as IrFunction
    expect(contentHash(fn)).toBe(contentHash(fn))
  })

  it('changes when the IR does', () => {
    const fn = moduleFor('print 1;').functions[0] as IrFunction
    const relabelled = relabel.run(fn).fn
    expect(contentHash(fn)).not.toBe(contentHash(relabelled))
  })

  it('separates two graphs that print the same but are not', () => {
    /*
     * `printFunction` prints block LABELS, which `ir.ts` documents as "for
     * reading, not for identity". A pass that split a block could give two
     * blocks the same label, and the printed form would stop distinguishing
     * them. `canonicalForm` prefixes the id-to-label map so it still does.
     */
    const fn = moduleFor('print 1;').functions[0] as IrFunction
    const renumbered: IrFunction = {
      ...fn,
      blocks: fn.blocks.map((block) => ({ ...block, id: block.id + 100 })),
      entry: fn.entry + 100
    }

    expect(canonicalForm(fn)).not.toBe(canonicalForm(renumbered))
    expect(contentHash(fn)).not.toBe(contentHash(renumbered))
  })

  it('produces a short, printable identifier', () => {
    const fn = moduleFor('print 1;').functions[0] as IrFunction
    expect(contentHash(fn)).toMatch(/^[0-9a-z]+$/)
  })
})
