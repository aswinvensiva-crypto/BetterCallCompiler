import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseSource } from '../../src/lang/parser'
import { resolve } from '../../src/lang/symbols'
import { typeCheck } from '../../src/lang/type-check'
import { lower, TOP_LEVEL_FUNCTION } from '../../src/lang/lower'
import { runPipeline } from '../../src/lang/pass-manager'
import { OPTIMISATION_PIPELINE } from '../../src/lang/passes'
import { compileModule } from '../../src/lang/bytecode'
import { createVm } from '../../src/lang/vm'
import { createDebugSession, type DebugSession } from '../../src/lang/debug'

/**
 * The debugger.
 *
 * Almost every test here is about a case where the obvious implementation is
 * subtly wrong: a breakpoint that re-fires on the line you resumed from, a step
 * over that lands inside the call, a breakpoint on a comment reported as set.
 * Each of those is a debugger that looks like it works and lies to its user,
 * which is worse than one that visibly does not.
 */

function sessionFor(source: string, path = 'x.bcc'): DebugSession {
  const { program, diagnostics } = parseSource(source)
  expect(diagnostics, 'the fixture should parse').toEqual([])
  const resolution = resolve(program)
  const report = runPipeline(
    lower(program, resolution, typeCheck(program, resolution)),
    OPTIMISATION_PIPELINE
  )
  expect(report.failure, report.failure?.message).toBeNull()

  const compiled = compileModule(report.module, TOP_LEVEL_FUNCTION)
  return createDebugSession(createVm(compiled), path)
}

const example = (name: string): string =>
  readFileSync(join(process.cwd(), 'examples', name), 'utf8')

/** The value of one local in the innermost frame. */
function local(session: DebugSession, name: string): string | undefined {
  const frame = session.stackFrames()[0]
  if (frame === undefined) return undefined
  return session.variables(frame.id).find((variable) => variable.name === name)?.value
}

describe('breakpoints', () => {
  it('verifies a line that has code', () => {
    // Line 10 of loop.bcc is `while i < 5 {`.
    expect(sessionFor(example('loop.bcc')).setBreakpoints([10])).toEqual([{ verified: true, line: 10 }])
  })

  it('moves one set on a comment to the next line with code', () => {
    /*
     * Reporting it verified anyway is the single most common way a debugger
     * lies: the user watches execution run past a solid red dot. Line 3 of
     * loop.bcc is a comment.
     */
    const [breakpoint] = sessionFor(example('loop.bcc')).setBreakpoints([3])

    expect(breakpoint?.verified).toBe(false)
    expect(breakpoint?.line).toBeGreaterThan(3)
    expect(breakpoint?.message).toContain('moved to line')
  })

  it('refuses one past the end of the program', () => {
    const [breakpoint] = sessionFor(example('loop.bcc')).setBreakpoints([999])
    expect(breakpoint?.verified).toBe(false)
    expect(breakpoint?.message).toContain('no code')
  })

  it('replaces the set rather than adding to it', () => {
    // The editor sends the whole set for a file each time, as DAP specifies.
    const session = sessionFor(example('loop.bcc'))
    session.setBreakpoints([10, 11])
    session.setBreakpoints([11])
    expect(session.breakpointLines()).toEqual([11])
  })

  it('stops at one, reporting the reason and the line', () => {
    const session = sessionFor(example('loop.bcc'))
    session.setBreakpoints([11])

    expect(session.continue_()).toEqual({ reason: 'breakpoint', line: 11, message: null })
  })

  it('does not re-fire on the line it resumed from', () => {
    /*
     * The bug found by driving `loop.bcc`: one source line is several
     * instructions, so after stopping the machine is still ON that line.
     * Checking breakpoints immediately makes Continue advance one instruction
     * and stop at the same place — the debugger looks frozen while quietly
     * making progress, which is worse than either.
     */
    const session = sessionFor(example('loop.bcc'))
    session.setBreakpoints([11])

    session.continue_()
    expect(local(session, 'i')).toBe('0')

    session.continue_()
    // The second iteration, not the same one again.
    expect(local(session, 'i')).toBe('1')
  })

  it('fires again when a loop comes back to the line', () => {
    // The other half of the rule above: suppression must last only until
    // execution leaves the line, or a breakpoint in a loop fires once.
    const session = sessionFor(example('loop.bcc'))
    session.setBreakpoints([11])

    const seen: (string | undefined)[] = []
    for (let iteration = 0; iteration < 5; iteration++) {
      expect(session.continue_().reason).toBe('breakpoint')
      seen.push(local(session, 'i'))
    }

    expect(seen).toEqual(['0', '1', '2', '3', '4'])
  })

  it('runs to the end when nothing is armed', () => {
    const session = sessionFor(example('loop.bcc'))
    expect(session.continue_()).toEqual({ reason: 'exited', line: null, message: null })
    expect(session.output()).toBe('10\n')
  })
})

describe('stepping forward', () => {
  const CALLER = [
    'fn twice(n: int) -> int {',
    '  let doubled = n * 2;',
    '  return doubled;',
    '}',
    'let a = 3;',
    'let b = twice(a);',
    'print b;'
  ].join('\n')

  it('step into descends into the call', () => {
    const session = sessionFor(CALLER)
    session.setBreakpoints([6])
    session.continue_()
    expect(session.stackFrames()).toHaveLength(1)

    // Somewhere inside `twice`, which is a deeper frame.
    let guard = 0
    while (session.stackFrames().length < 2 && guard++ < 20) session.stepInto()

    expect(session.stackFrames()[0]?.name).toBe('twice')
  })

  it('step over runs the call to completion without stopping inside', () => {
    /*
     * The classic debugger bug: the callee's first instruction has a different
     * line, so a "step over" implemented as "run until the line changes" stops
     * inside the call. The depth check is what prevents it.
     */
    const session = sessionFor(CALLER)
    session.setBreakpoints([6])
    session.continue_()

    const before = session.stackFrames().length
    session.stepOver()

    expect(session.stackFrames().length).toBeLessThanOrEqual(before)
    expect(session.stackFrames()[0]?.name).toBe(TOP_LEVEL_FUNCTION)
  })

  it('step over still stops at a breakpoint inside the call', () => {
    // A debugger that ignored breakpoints during a step would run past the one
    // moment the user was waiting for.
    const session = sessionFor(CALLER)
    session.setBreakpoints([6, 2])
    session.continue_()

    const stop = session.stepOver()
    expect(stop.reason).toBe('breakpoint')
    expect(session.stackFrames()[0]?.name).toBe('twice')
  })

  it('step out returns to the caller', () => {
    const session = sessionFor(CALLER)
    session.setBreakpoints([2])
    session.continue_()
    expect(session.stackFrames()[0]?.name).toBe('twice')

    session.stepOut()
    expect(session.stackFrames()[0]?.name).toBe(TOP_LEVEL_FUNCTION)
  })

  it('step out of the outermost frame runs to the end rather than doing nothing', () => {
    const session = sessionFor('print 1;\nprint 2;')
    expect(session.stepOut().reason).toBe('exited')
    expect(session.output()).toBe('1\n2\n')
  })

  it('a step moves a LINE, not an instruction', () => {
    // `let a = 3;` is several instructions. Stopping at each would be unusable.
    const session = sessionFor('let a = 1;\nlet b = 2;\nprint a + b;')
    const first = session.currentLine()
    const after = session.stepInto()

    expect(after.line).not.toBe(first)
  })
})

describe('stepping backwards', () => {
  /*
   * The capability the plan calls "the feature no incumbent can offer on a real
   * toolchain, and the reason the runtime is ours". It is short only because
   * Part 9 made the VM reversible.
   */

  it('steps back over a loop iteration and the local holds its earlier value', () => {
    const session = sessionFor(example('loop.bcc'))
    session.setBreakpoints([11])

    session.continue_()
    session.continue_()
    session.continue_()
    expect(local(session, 'i')).toBe('2')

    // Backwards to the previous time round.
    session.reverseContinue()
    expect(local(session, 'i')).toBe('1')

    session.reverseContinue()
    expect(local(session, 'i')).toBe('0')
  })

  it('steps back one line', () => {
    const session = sessionFor('let a = 1;\nlet b = 2;\nprint a + b;')
    session.stepInto()
    const second = session.currentLine()

    session.stepInto()
    expect(session.currentLine()).not.toBe(second)

    session.stepBack()
    expect(session.currentLine()).toBe(second)
  })

  it('back one then forward one returns to the same line', () => {
    const session = sessionFor(example('loop.bcc'))
    session.setBreakpoints([11])
    session.continue_()
    session.continue_()

    const line = session.currentLine()
    const value = local(session, 'i')

    session.stepBack()
    session.stepInto()

    expect(session.currentLine()).toBe(line)
    expect(local(session, 'i')).toBe(value)
  })

  it('reports reaching the beginning rather than pretending to move', () => {
    const session = sessionFor('print 1;')
    const stop = session.reverseContinue()
    expect(stop.reason).toBe('start')
  })

  it('un-prints when it goes back', () => {
    // The VM records output rather than performing it, so the console is a
    // function of where execution IS, not of how the user navigated there.
    const session = sessionFor('print 1;\nprint 2;\nprint 3;')
    session.continue_()
    expect(session.output()).toBe('1\n2\n3\n')

    session.reverseContinue()
    expect(session.output()).toBe('')
  })
})

describe('inspecting', () => {
  it('names parameters and loop variables', () => {
    /*
     * Both survive mem2reg — parameters because they are parameters, loop
     * variables because they become phis, which carry the name they came from.
     */
    const session = sessionFor(example('loop.bcc'))
    session.setBreakpoints([11])
    session.continue_()

    const names = session.variables(session.stackFrames()[0]?.id ?? 1).map((variable) => variable.name)
    expect(names).toContain('i')
    expect(names).toContain('total')
  })

  it('omits compiler temporaries rather than showing them as %4', () => {
    // Noise for a user and a lie for a teacher: the variable it came from is
    // what they are looking for, and it is not recoverable after mem2reg.
    const session = sessionFor(example('loop.bcc'))
    session.setBreakpoints([11])
    session.continue_()

    for (const variable of session.variables(session.stackFrames()[0]?.id ?? 1)) {
      expect(variable.name).not.toMatch(/^%/)
    }
  })

  it('reports types the language actually has', () => {
    const session = sessionFor('fn f(a: int, b: bool) -> int { if b { return a; } else { return 0; } }\nprint f(7, true);')
    session.setBreakpoints([1])
    session.continue_()

    const variables = session.variables(session.stackFrames()[0]?.id ?? 1)
    expect(variables.find((variable) => variable.name === 'a')).toMatchObject({ value: '7', type: 'int' })
    expect(variables.find((variable) => variable.name === 'b')).toMatchObject({ value: 'true', type: 'bool' })
  })

  it('gives each frame its own locals', () => {
    const session = sessionFor(
      'fn inner(x: int) -> int { return x + 1; }\nfn outer(y: int) -> int { return inner(y * 2); }\nprint outer(5);'
    )
    session.setBreakpoints([1])
    session.continue_()

    expect(session.stackFrames().map((frame) => frame.name)).toEqual(['inner', 'outer', TOP_LEVEL_FUNCTION])

    const [inner, outer] = session.stackFrames()
    expect(session.variables(inner?.id ?? 0).find((v) => v.name === 'x')?.value).toBe('10')
    expect(session.variables(outer?.id ?? 0).find((v) => v.name === 'y')?.value).toBe('5')
  })

  it('identifies a frame by depth, which survives a step', () => {
    /*
     * An index into the reversed array would read the wrong frame after the
     * stack changed. Depth is stable for as long as the frame is.
     */
    const session = sessionFor(
      'fn inner(x: int) -> int { return x + 1; }\nfn outer(y: int) -> int { return inner(y); }\nprint outer(5);'
    )
    session.setBreakpoints([1])
    session.continue_()

    const outerId = session.stackFrames()[1]?.id
    session.stepOut()

    expect(session.stackFrames()[0]?.id).toBe(outerId)
    expect(session.variables(outerId ?? 0).find((v) => v.name === 'y')?.value).toBe('5')
  })

  it('offers one scope, because BCC has no globals to put in a second', () => {
    const session = sessionFor(example('loop.bcc'))
    expect(session.scopes(1)).toEqual([{ name: 'Locals', variablesReference: 1, expensive: false }])
  })
})

describe('a program that has ended', () => {
  it('has no stack, rather than one frame parked on a comment', () => {
    /*
     * Found by driving the worker: after `loop.bcc` exited, the stop reported
     * `line: null` — correct — while `stackFrames` still offered `<main>` at
     * LINE 1, which is a comment. The VM keeps the outermost frame after the
     * program returns, and the frame's pc is then past the last instruction, so
     * `stackFrames` fell back to the function's own span — and `<main>`'s span
     * is the whole file.
     *
     * The UI would have highlighted line 1 and shown a locals pane for a frame
     * that is not executing. A finished program has no stack; that is what
     * every debugger reports, and it is what is true here.
     */
    const session = sessionFor(example('loop.bcc'))
    session.continue_()

    expect(session.finished(), 'the fixture should have run to the end').toBe(true)
    expect(session.stackFrames()).toEqual([])
    expect(session.variables(1)).toEqual([])
  })

  it('gets its stack back the moment it steps backwards', () => {
    // The pane clearing at exit is only acceptable because the state is one
    // command away — which is the whole argument for a reversible VM.
    const session = sessionFor(example('loop.bcc'))
    session.continue_()
    session.stepBack()

    expect(session.stackFrames().length).toBe(1)
    expect(local(session, 'total'), 'the answer it printed').toBe('10')
  })

  it('keeps the stack when it FAILED rather than finished', () => {
    /*
     * The guard is on `finished`, not on "not running". A trap is the one
     * moment the stack matters most — it is where the program broke — and an
     * exception stop that cleared the pane would throw away the answer the user
     * opened the debugger for.
     */
    const session = sessionFor('fn f(a: int) -> int { return 1 / a; }\nprint f(0);')
    expect(session.continue_().reason).toBe('exception')

    const frames = session.stackFrames()
    expect(frames.length).toBeGreaterThan(0)
    expect(frames[0]?.name).toBe('f')
  })
})

describe('a program that fails', () => {
  it('stops with the reason and the message', () => {
    const session = sessionFor('fn f(a: int) -> int { return 1 / a; }\nprint f(0);')
    const stop = session.continue_()

    expect(stop.reason).toBe('exception')
    expect(stop.message).toBe('division by zero')
    expect(stop.line).toBe(1)
  })

  it('can be stepped backwards out of the failure', () => {
    // The reason to own the runtime: the moment before the crash is inspectable
    // rather than gone.
    const session = sessionFor('fn f(a: int) -> int { return 1 / a; }\nprint f(0);')
    expect(session.continue_().reason).toBe('exception')

    session.stepBack()
    expect(session.finished()).toBe(false)
  })
})
