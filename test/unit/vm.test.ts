import { describe, expect, it } from 'vitest'
import { parseSource } from '../../src/lang/parser'
import { resolve } from '../../src/lang/symbols'
import { typeCheck } from '../../src/lang/type-check'
import { lower, TOP_LEVEL_FUNCTION } from '../../src/lang/lower'
import { runPipeline } from '../../src/lang/pass-manager'
import { OPTIMISATION_PIPELINE } from '../../src/lang/passes'
import { compileModule, type Program } from '../../src/lang/bytecode'
import { createVm, type Vm, type VmOptions } from '../../src/lang/vm'

/**
 * The VM.
 *
 * Two halves. The execution suite asserts that programs with known answers
 * produce them — the ordinary thing a VM has to do. The reversibility section
 * asserts the amendment's property, which is the thing no incumbent can offer
 * on a real toolchain and therefore the thing worth being strict about.
 */

function compile(source: string): Program {
  const { program, diagnostics } = parseSource(source)
  expect(diagnostics, `parse errors in ${JSON.stringify(source)}`).toEqual([])
  const resolution = resolve(program)
  const report = runPipeline(
    lower(program, resolution, typeCheck(program, resolution)),
    OPTIMISATION_PIPELINE
  )
  expect(report.failure, report.failure?.message).toBeNull()
  return compileModule(report.module, TOP_LEVEL_FUNCTION)
}

function vmFor(source: string, options: VmOptions = {}): Vm {
  return createVm(compile(source), options)
}

/** Run to completion and return what it printed. */
function outputOf(source: string): string {
  const vm = vmFor(source)
  vm.run()
  expect(vm.error()?.message, `unexpected error in ${JSON.stringify(source)}`).toBeUndefined()
  expect(vm.status()).toBe('finished')
  return vm.outputText()
}

/* -------------------------------------------------------------------------- */
/*  Execution                                                                  */
/* -------------------------------------------------------------------------- */

describe('the execution suite', () => {
  /*
   * Programs with answers known independently of this implementation. Anything
   * that only agrees with itself proves nothing.
   */

  it.each([
    ['print 1 + 2;', '3\n'],
    ['print 7 - 3;', '4\n'],
    ['print 6 * 7;', '42\n'],
    ['print 9 / 2;', '4\n'],
    ['print -9 / 2;', '-4\n'],
    ['print 9 % 2;', '1\n'],
    ['print -5 + 1;', '-4\n'],
    ['print 1 < 2;', 'true\n'],
    ['print 1 == 2;', 'false\n'],
    ['print !false;', 'true\n'],
    ['print 1; print 2;', '1\n2\n']
  ])('runs %j', (source, expected) => {
    expect(outputOf(source)).toBe(expected)
  })

  it('runs a counted loop', () => {
    expect(outputOf('let i = 0;\nwhile i < 3 { print i; i = i + 1; }')).toBe('0\n1\n2\n')
  })

  it('runs a loop whose body never executes', () => {
    expect(outputOf('let i = 5;\nwhile i < 3 { print i; i = i + 1; }\nprint 99;')).toBe('99\n')
  })

  it('takes the branch the condition selects', () => {
    const source = (n: number): string =>
      `fn pick(a: int) -> int { if a > 0 { return 1; } else { return 2; } }\nprint pick(${n});`
    expect(outputOf(source(5))).toBe('1\n')
    expect(outputOf(source(-5))).toBe('2\n')
  })

  it('calls a function with arguments in the right order', () => {
    // `sub(10, 3)` is 7 and `sub(3, 10)` is -7, so an argument swap is visible.
    const source = 'fn sub(a: int, b: int) -> int { return a - b; }\nprint sub(10, 3);'
    expect(outputOf(source)).toBe('7\n')
  })

  it('recurses', () => {
    // fib(10) is 55, which nothing in this repository computes another way.
    const source =
      'fn fib(n: int) -> int { if n < 2 { return n; } else { return fib(n - 1) + fib(n - 2); } }\nprint fib(10);'
    expect(outputOf(source)).toBe('55\n')
  })

  it('keeps each frame\'s locals separate', () => {
    /*
     * The recursion above would pass even if frames shared slots, because it
     * never reads a local after a nested call returns. This does.
     */
    const source = [
      'fn outer(a: int) -> int {',
      '  let mine = a * 10;',
      '  let theirs = inner(a + 1);',
      '  return mine + theirs;',
      '}',
      'fn inner(b: int) -> int { let mine = b * 100; return mine; }',
      'print outer(2);'
    ].join('\n')

    // outer: mine = 20, inner(3) = 300, so 320.
    expect(outputOf(source)).toBe('320\n')
  })

  it('runs a function whose result nobody uses', () => {
    expect(outputOf('fn shout() { print 7; }\nshout();\nprint 8;')).toBe('7\n8\n')
  })
})

describe('when a program goes wrong', () => {
  it('traps on division by zero, with a span', () => {
    /*
     * The choice Part 8's folder deliberately deferred. It refused to fold
     * `1 / 0` so the VM could decide once for both spellings — this is that
     * decision, and the span is what lets the editor point at it.
     */
    const vm = vmFor('fn f(a: int) -> int { return 1 / a; }\nprint f(0);')
    vm.run()

    expect(vm.status()).toBe('error')
    expect(vm.error()?.message).toBe('division by zero')
    expect(vm.error()?.span.startLine).toBe(1)
  })

  it('traps on remainder by zero too', () => {
    const vm = vmFor('fn f(a: int) -> int { return 1 % a; }\nprint f(0);')
    vm.run()
    expect(vm.error()?.message).toBe('remainder by zero')
  })

  it('agrees with the folder about a constant division', () => {
    // `9 / 2` folded at compile time and `9 / a` computed here must produce the
    // same number, or the language means different things in the two spellings.
    const folded = outputOf('print 9 / 2;')
    const computed = outputOf('fn d(a: int, b: int) -> int { return a / b; }\nprint d(9, 2);')
    expect(computed).toBe(folded)
  })

  it('stops a program that does not terminate', () => {
    const vm = vmFor('while true { }', { stepLimit: 5_000 })
    vm.run()

    expect(vm.status()).toBe('error')
    expect(vm.error()?.message).toContain('may not terminate')
  })

  it('stops runaway recursion before the host stack does', () => {
    // A JavaScript RangeError here would be an implementation detail leaking
    // out; the VM owns its own limit and reports it in the program's terms.
    const vm = vmFor('fn f(n: int) -> int { return f(n + 1); }\nprint f(0);', {
      callDepthLimit: 64
    })
    vm.run()

    expect(vm.status()).toBe('error')
    expect(vm.error()?.message).toContain('runaway recursion')
  })

  it('prints nothing after the trap', () => {
    const vm = vmFor('fn f(a: int) -> int { return 1 / a; }\nprint 1;\nprint f(0);\nprint 2;')
    vm.run()
    expect(vm.outputText()).toBe('1\n')
  })
})

/* -------------------------------------------------------------------------- */
/*  Reversibility                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The programs the reversibility properties run over.
 *
 * Chosen to exercise every way the machine mutates: slots, the operand stack,
 * frames pushed and popped, output, and the loop-carried phi stores.
 */
const REVERSIBLE_PROGRAMS = [
  'print 1 + 2;',
  'print 1; print 2; print 3;',
  'let i = 0;\nwhile i < 3 { print i; i = i + 1; }',
  'let x = 0;\nif 1 < 2 { x = 10; } else { x = 20; }\nprint x;',
  'fn add(a: int, b: int) -> int { return a + b; }\nprint add(2, 3);',
  'fn fib(n: int) -> int { if n < 2 { return n; } else { return fib(n - 1) + fib(n - 2); } }\nprint fib(6);',
  'fn shout() { print 7; }\nshout();\nprint 8;',
  'fn outer(a: int) -> int { let mine = a * 10; return mine + inner(a); }\nfn inner(b: int) -> int { return b * 100; }\nprint outer(2);'
]

/** Everything observable about the machine, for comparing two moments. */
function snapshot(vm: Vm): string {
  return JSON.stringify({
    status: vm.status(),
    steps: vm.stepCount(),
    span: vm.currentSpan(),
    output: vm.output(),
    frames: vm.frames().map((frame) => ({
      fn: frame.fn.name,
      pc: frame.pc,
      slots: frame.slots
    }))
  })
}

describe('stepping backwards', () => {
  /*
   * The amendment's property, stated twice: forward N then back N returns to
   * the state at step 0, and back-one-then-forward-one is the identity at every
   * step. The second is the stronger one — it catches a machine that happens to
   * unwind correctly in bulk while being wrong at individual steps.
   */

  it.each(REVERSIBLE_PROGRAMS)('forward N then back N is where it started: %j', (source) => {
    const vm = vmFor(source)
    const start = snapshot(vm)

    while (vm.step()) {
      // To the end.
    }
    /*
     * The VM's own count, not one kept here: `step` returns false on the step
     * that FINISHES the program, so a loop counter misses the last one. Asking
     * the machine is both simpler and the number the property is about.
     */
    const executed = vm.stepCount()
    expect(executed, 'the program should have executed something').toBeGreaterThan(0)

    let backward = 0
    while (vm.stepBack()) backward++

    expect(snapshot(vm)).toBe(start)
    // Every executed step is undoable, so these match exactly.
    expect(backward).toBe(executed)
  })

  it.each(REVERSIBLE_PROGRAMS)('back one then forward one is the identity: %j', (source) => {
    const vm = vmFor(source)

    for (;;) {
      const before = snapshot(vm)
      if (!vm.step()) break
      const after = snapshot(vm)

      expect(vm.stepBack()).toBe(true)
      expect(snapshot(vm), 'stepping back did not restore the previous state').toBe(before)

      expect(vm.step()).toBe(true)
      expect(snapshot(vm), 'stepping forward again did not reproduce the next state').toBe(after)
    }
  })

  it('un-prints, so output does not depend on how you navigated', () => {
    /*
     * The reason `print` is recorded rather than performed. If it wrote to
     * stdout, stepping back over a print and forward again would print twice —
     * the output would be a function of the user's navigation.
     */
    const vm = vmFor('print 1; print 2;')
    vm.run()
    expect(vm.outputText()).toBe('1\n2\n')

    while (vm.stepBack()) {
      // All the way back.
    }
    expect(vm.outputText()).toBe('')

    vm.run()
    expect(vm.outputText()).toBe('1\n2\n')
  })

  it('restores a frame a return removed', () => {
    const vm = vmFor('fn add(a: int, b: int) -> int { return a + b; }\nprint add(2, 3);')

    // Step until the callee's frame exists, and remember exactly where.
    while (vm.frames().length < 2 && vm.step()) {
      // Looking for the call.
    }
    expect(vm.frames().length).toBe(2)
    const insideSteps = vm.stepCount()
    const inside = snapshot(vm)

    // Run past the return, so the frame is genuinely gone.
    vm.run()
    expect(vm.frames().length).toBe(1)

    /*
     * Rewind to the same STEP, not to the same frame count. Stepping back
     * until two frames exist again lands immediately after the return was
     * undone — deep inside the callee rather than at its entry — so it is a
     * different moment and comparing against it was my error, not the VM's.
     */
    while (vm.stepCount() > insideSteps) expect(vm.stepBack()).toBe(true)

    expect(vm.frames().length).toBe(2)
    // Identical, slots included: the frame was restored, not reconstructed.
    expect(snapshot(vm)).toBe(inside)
  })

  it('steps back out of a finished program', () => {
    // The last step is the one that finishes it; undoing that must make the
    // machine runnable again, or a debugger could never inspect the end.
    const vm = vmFor('print 1;')
    vm.run()
    expect(vm.status()).toBe('finished')

    expect(vm.stepBack()).toBe(true)
    expect(vm.status()).toBe('running')
    expect(vm.step()).toBe(false)
    expect(vm.status()).toBe('finished')
  })

  it('steps back out of a trap', () => {
    const vm = vmFor('fn f(a: int) -> int { return 1 / a; }\nprint f(0);')
    vm.run()
    expect(vm.status()).toBe('error')

    expect(vm.stepBack()).toBe(true)
    expect(vm.status()).toBe('running')
    expect(vm.error()).toBeNull()
  })

  it('reports that there is no more history rather than inventing state', () => {
    const vm = vmFor('print 1;')
    expect(vm.stepBack()).toBe(false)
    expect(vm.historyDepth()).toBe(0)
  })
})

describe('the history bound', () => {
  /*
   * An unbounded log on a hot loop is a memory leak that only appears in the
   * demo. The bound is on RECORDED steps, not on execution.
   */

  it('keeps running past the limit, at full speed', () => {
    const vm = vmFor('let i = 0;\nwhile i < 200 { print i; i = i + 1; }', { historyLimit: 50 })
    vm.run()

    expect(vm.status()).toBe('finished')
    expect(vm.stepCount()).toBeGreaterThan(50)
    expect(vm.outputText().split('\n')).toHaveLength(201)
  })

  it('keeps the most recent history and says the rest is gone', () => {
    const vm = vmFor('let i = 0;\nwhile i < 200 { i = i + 1; }\nprint i;', { historyLimit: 50 })
    vm.run()

    expect(vm.historyDepth()).toBe(50)
    // The UI needs to know the past is partial rather than being offered a
    // step back that lands somewhere wrong.
    expect(vm.historyTruncated()).toBe(true)

    let back = 0
    while (vm.stepBack()) back++
    expect(back).toBe(50)
  })

  it('keeps a correct history when far more steps run than it can hold', () => {
    /*
     * Correctness at scale — 400x more steps than the log holds — which is
     * where an eviction bug would corrupt what is retained.
     *
     * It does NOT catch the performance bug that prompted it, and saying so
     * matters: the first version evicted with `history.shift()`, O(n) per step
     * on a full log, and a program printing 40,000 lines never finished. At the
     * small limit used here the quadratic term is invisible — reverting to the
     * O(n) eviction still passes this in two seconds. What catches it is
     * `npm run test:vm`, which runs a real program at the DEFAULT 200k limit,
     * where the cost is 2.4e10 element moves. A unit test at that size would
     * take half a minute, so the fast check lives in the harness and this one
     * pins the behaviour the ring has to preserve.
     */
    const vm = vmFor('let i = 0;\nwhile i < 20000 { i = i + 1; }\nprint i;', { historyLimit: 500 })
    vm.run()

    expect(vm.status()).toBe('finished')
    expect(vm.outputText()).toBe('20000\n')
    expect(vm.stepCount()).toBeGreaterThan(100_000)
    expect(vm.historyDepth()).toBe(500)
    expect(vm.historyTruncated()).toBe(true)

    // And the retained history is still correct, not merely present.
    let back = 0
    while (vm.stepBack()) back++
    expect(back).toBe(500)
  })

  it('does not claim truncation when nothing was dropped', () => {
    const vm = vmFor('print 1;', { historyLimit: 1_000 })
    vm.run()
    expect(vm.historyTruncated()).toBe(false)
  })
})

describe('what a debugger needs from it', () => {
  it('names the span of the instruction about to run', () => {
    // This is what Part 10 highlights, and how a breakpoint is recognised.
    const vm = vmFor('print 1;\nprint 2;')

    const seen: number[] = []
    while (vm.status() === 'running') {
      const span = vm.currentSpan()
      if (span !== null) seen.push(span.startLine)
      if (!vm.step()) break
    }

    expect(seen).toContain(1)
    expect(seen).toContain(2)
  })

  it('reports the call stack innermost first', () => {
    const vm = vmFor('fn a() -> int { return b(); }\nfn b() -> int { return 1; }\nprint a();')

    while (vm.frames().length < 3 && vm.step()) {
      // Down to b.
    }

    expect(vm.frames().map((frame) => frame.fn.name)).toEqual(['b', 'a', TOP_LEVEL_FUNCTION])
  })

  it('exposes each frame\'s slots, which is the locals view', () => {
    const vm = vmFor('fn f(a: int, b: int) -> int { return a + b; }\nprint f(4, 5);')

    while (vm.frames().length < 2 && vm.step()) {
      // Into f.
    }

    const inner = vm.frames()[0]
    expect(inner?.fn.name).toBe('f')
    // Parameters occupy the first slots, in order.
    expect(inner?.slots.slice(0, 2)).toEqual([4, 5])
  })
})
