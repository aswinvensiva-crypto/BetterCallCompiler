import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isVmWorkerRequest, prepare, SLICE_STEPS } from '../../src/main/lang-vm-worker'

/**
 * Turning a `.bcc` file into a running VM, and refusing to when it cannot.
 *
 * `prepare` is exported and pure so every failure — a parse error, a type
 * error, IR the pipeline refuses — can be driven without a worker. The worker
 * loop above it is thin by design; what is worth testing is the decision about
 * whether a program can run at all, and what it says when it cannot.
 */

describe('programs that run', () => {
  it('compiles and runs the simplest thing', () => {
    const { vm, errors } = prepare('print 1 + 2;', 'a.bcc')
    expect(errors).toEqual([])
    vm?.run()
    expect(vm?.outputText()).toBe('3\n')
  })

  it('runs every example in the repository', () => {
    /*
     * The plan's own hygiene note: "the plan's headline demo opens
     * `examples/fib.bcc` and no `.bcc` file exists anywhere in the repo." They
     * exist now, so they have to keep working — an example that stops running
     * is worse than none, because it is the first thing anyone opens.
     */
    const directory = join(process.cwd(), 'examples')
    const names = readdirSync(directory).filter((name) => name.endsWith('.bcc'))

    expect(names.length, 'there should be examples to run').toBeGreaterThan(0)

    for (const name of names) {
      const { vm, errors } = prepare(readFileSync(join(directory, name), 'utf8'), name)
      expect(errors, `${name} should compile`).toEqual([])
      vm?.run()
      expect(vm?.status(), `${name} should finish`).toBe('finished')
      expect(vm?.error()?.message, `${name} should not trap`).toBeUndefined()
    }
  })

  it.each([
    ['fib.bcc', '0\n1\n1\n2\n3\n5\n8\n13\n21\n34\n'],
    ['loop.bcc', '10\n'],
    ['folding.bcc', '10\n100\n4\n']
  ])('%s prints exactly what it says it will', (name, expected) => {
    // Known independently: the first ten Fibonacci numbers, 0+1+2+3+4, and
    // `2*3+4` / the folded branch / truncating division.
    const { vm } = prepare(readFileSync(join(process.cwd(), 'examples', name), 'utf8'), name)
    vm?.run()
    expect(vm?.outputText()).toBe(expected)
  })
})

describe('programs that cannot run', () => {
  it('reports a parse error with the file, line and column', () => {
    const { vm, errors } = prepare('print 1 +;', 'broken.bcc')

    expect(vm).toBeNull()
    expect(errors[0]).toMatch(/^broken\.bcc:1:\d+ BCC\d+: /)
  })

  it('reports a type error rather than running the program anyway', () => {
    // The Run panel and the Problems panel read the same diagnostics, so they
    // cannot disagree about whether a program is runnable.
    const { vm, errors } = prepare('let x: int = true;', 'typed.bcc')

    expect(vm).toBeNull()
    expect(errors.join(' ')).toMatch(/BCC\d+/)
  })

  it('reports an unknown name', () => {
    const { vm, errors } = prepare('print nope;', 'unknown.bcc')
    expect(vm).toBeNull()
    expect(errors.join(' ')).toMatch(/BCC\d+/)
  })

  it('reports every diagnostic, not just the first', () => {
    const { errors } = prepare('print nope;\nprint alsoNope;', 'many.bcc')
    expect(errors.length).toBeGreaterThan(1)
  })

  it('blames the user only for the user\'s mistakes', () => {
    /*
     * Every error above names a line in the file. The one case `prepare` does
     * NOT phrase that way is a pipeline failure, which is a compiler bug and
     * says "internal compiler error" instead — no source can currently reach
     * it, so there is no test for it here, and pretending otherwise with an
     * assertion that compares a string to itself would be worse than the gap.
     */
    for (const [source, name] of [
      ['print 1 +;', 'a.bcc'],
      ['print nope;', 'b.bcc']
    ] as const) {
      for (const error of prepare(source, name).errors) {
        expect(error, error).toContain(`${name}:`)
        expect(error, error).not.toContain('internal compiler error')
      }
    }
  })
})

describe('the worker protocol', () => {
  /*
   * The guard enumerates its type strings by hand, which is the one thing
   * TypeScript does not check — the same gap `isWorkerMessage` has, and the
   * same reason it gets a test.
   */

  it('accepts both requests', () => {
    expect(isVmWorkerRequest({ type: 'run', runId: 'r1', source: '', relativePath: 'a.bcc' })).toBe(true)
    expect(isVmWorkerRequest({ type: 'cancel', runId: 'r1' })).toBe(true)
  })

  it('rejects near misses', () => {
    expect(isVmWorkerRequest({ type: 'Run', runId: 'r1' })).toBe(false)
    expect(isVmWorkerRequest({ type: 'run' })).toBe(false)
    expect(isVmWorkerRequest({ runId: 'r1' })).toBe(false)
    expect(isVmWorkerRequest(null)).toBe(false)
    expect(isVmWorkerRequest('run')).toBe(false)
  })
})

describe('slicing', () => {
  it('yields often enough that a cancel is honoured promptly', () => {
    /*
     * The slice size is a latency budget, not a tuning knob: it is how long a
     * cancel can wait. 50k instructions is well under a millisecond, and the
     * VM's own step limit is a thousand times larger — so a runaway program
     * still yields many times before it is stopped.
     */
    expect(SLICE_STEPS).toBeLessThanOrEqual(100_000)
    expect(SLICE_STEPS).toBeGreaterThan(0)
  })
})
