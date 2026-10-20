import { Worker } from 'node:worker_threads'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * The VM worker, in a real thread.
 *
 * The unit tests drive `prepare` directly, which is the right way to test the
 * decisions — but it deliberately skips everything this harness is about: that
 * the built worker file exists where the runner looks for it, that the protocol
 * survives a structured clone, that output arrives in slices while a program is
 * still running rather than all at the end, and that a runaway program can
 * actually be terminated.
 *
 * None of that can fail in a unit test, and all of it can fail in the app.
 */

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const workerPath = join(root, 'out', 'main', 'lang-vm-worker.js')

let failures = 0

function check(what, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  const label = ok ? 'PASS' : 'FAIL'
  console.log(`${label}  ${what}: ${JSON.stringify(actual)}`)
  if (!ok) console.log(`      expected ${JSON.stringify(expected)}`)
}

function assert(what, condition, detail) {
  if (!condition) failures++
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${what}${detail === undefined ? '' : `: ${detail}`}`)
}

/** Run one program to completion, collecting everything the worker said. */
function runProgram(source, relativePath, { cancelAfterMs } = {}) {
  return new Promise((settle, reject) => {
    const worker = new Worker(workerPath)
    const chunks = []
    const stderr = []
    const timestamps = []
    const started = Date.now()

    const timer = setTimeout(() => {
      worker.terminate()
      reject(new Error(`${relativePath} did not finish within 30s`))
    }, 30_000)

    worker.on('message', (message) => {
      if (message.type === 'output') {
        timestamps.push(Date.now() - started)
        if (message.stream === 'stderr') stderr.push(message.text)
        else chunks.push(message.text)
        return
      }

      clearTimeout(timer)
      void worker.terminate()
      settle({ code: message.code, steps: message.steps, out: chunks.join(''), err: stderr.join(''), chunks, timestamps })
    })

    worker.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })

    worker.postMessage({ type: 'run', runId: 'proof', source, relativePath })

    if (cancelAfterMs !== undefined) {
      setTimeout(() => worker.postMessage({ type: 'cancel', runId: 'proof' }), cancelAfterMs)
    }
  })
}

/**
 * Hold a worker open under debugger control and drive it command by command.
 *
 * `runProgram` above is fire-and-forget; a debug session is a conversation, so
 * this keeps the worker alive and hands back a promise per exchange. Replies are
 * queued rather than assumed to arrive after the request, because a `stopped`
 * message posted while nobody was waiting would otherwise be lost and every
 * later answer would be off by one.
 */
function openDebugSession(source, relativePath, breakpoints) {
  const worker = new Worker(workerPath)
  const waiting = []
  const queued = []

  worker.on('message', (message) => {
    if (message.type !== 'stopped') return
    const next = waiting.shift()
    if (next === undefined) queued.push(message)
    else next(message)
  })

  const receive = () =>
    Promise.race([
      new Promise((settle) => {
        const ready = queued.shift()
        if (ready === undefined) waiting.push(settle)
        else settle(ready)
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('the worker did not answer within 30s')), 30_000).unref()
      )
    ])

  const send = (message) => {
    worker.postMessage(message)
    return receive()
  }

  worker.postMessage({ type: 'debug', runId: 'dbg', source, relativePath, breakpoints })

  return {
    next: receive,
    command: (command) => send({ type: 'command', runId: 'dbg', command }),
    setBreakpoints: (lines) => send({ type: 'breakpoints', runId: 'dbg', lines }),
    close: () => void worker.terminate()
  }
}

/** A local's value in the innermost frame, or null when it is not there. */
function local(stop, name) {
  const innermost = stop.frames[0]
  if (innermost === undefined) return null
  const scope = stop.locals.find((entry) => entry.frameId === innermost.id)
  return scope?.variables.find((variable) => variable.name === name)?.value ?? null
}

console.log('--- the worker exists where the runner looks for it ---')
try {
  readFileSync(workerPath)
  assert('out/main/lang-vm-worker.js was built', true)
} catch {
  assert('out/main/lang-vm-worker.js was built', false, 'run `npm run build` first')
  process.exit(1)
}

console.log('\n--- every example runs, through the real worker ---')
const examples = join(root, 'examples')
for (const name of readdirSync(examples).filter((file) => file.endsWith('.bcc')).sort()) {
  const source = readFileSync(join(examples, name), 'utf8')
  const result = await runProgram(source, name)
  check(`${name} exits 0`, result.code, 0)
  assert(`${name} printed something`, result.out.length > 0, JSON.stringify(result.out.slice(0, 40)))
}

console.log('\n--- known answers ---')
{
  const fib = await runProgram(readFileSync(join(examples, 'fib.bcc'), 'utf8'), 'fib.bcc')
  check('fib.bcc prints the first ten Fibonacci numbers', fib.out, '0\n1\n1\n2\n3\n5\n8\n13\n21\n34\n')
}

console.log('\n--- a program that cannot compile ---')
{
  const broken = await runProgram('print 1 +;', 'broken.bcc')
  check('exit code says compile error', broken.code, 2)
  assert('the message names the file and line', /^broken\.bcc:1:\d+/.test(broken.err), broken.err.trim())
  check('nothing was printed to stdout', broken.out, '')
}

console.log('\n--- a program that traps ---')
{
  const trap = await runProgram('fn f(a: int) -> int { return 1 / a; }\nprint 1;\nprint f(0);', 'trap.bcc')
  check('exit code says the program failed', trap.code, 1)
  check('what it managed to print is kept', trap.out, '1\n')
  assert('the trap names a line', /trap\.bcc:\d+:\d+ division by zero/.test(trap.err), trap.err.trim())
}

console.log('\n--- output arrives while the program is still running ---')
{
  /*
   * The reason the loop is sliced. Posting only at the end would make a long
   * program look hung; posting per `print` would be one message per instruction.
   * A program that prints a lot should produce several messages spread over
   * time, not one at the end.
   */
  const chatty = await runProgram(
    'let i = 0;\nwhile i < 40000 { print i; i = i + 1; }',
    'chatty.bcc'
  )
  check('it finished', chatty.code, 0)
  assert('it printed 40000 lines', chatty.out.split('\n').length === 40001, String(chatty.out.split('\n').length))
  assert(
    'output came in more than one message',
    chatty.chunks.length > 1,
    `${chatty.chunks.length} messages`
  )
}

console.log('\n--- a runaway program can be cancelled ---')
{
  /*
   * The whole reason this is a worker. `while true { }` has no output and never
   * ends; the VM's own step limit would stop it eventually, but the window must
   * stay responsive and Cancel must mean it.
   */
  const runaway = await runProgram('while true { }', 'runaway.bcc', { cancelAfterMs: 200 })
  check('exit code says cancelled', runaway.code, 130)
  assert('it was stopped early', runaway.steps > 0, `${runaway.steps} steps`)
}

console.log('\n--- a debug session, over the real message channel ---')
{
  /*
   * The whole Part 10 story end to end, through a structured clone. The unit
   * tests drive `createDebugSession` directly, which is the right way to test
   * the stepping rules — but it never sends a `DebugStop`, a `DapStackFrame` or
   * a locals table across a thread boundary, and the debugger is useless if
   * those do not survive the trip.
   */
  const session = openDebugSession(readFileSync(join(examples, 'loop.bcc'), 'utf8'), 'loop.bcc', [11])

  const entry = await session.next()
  check('a session starts paused at entry', entry.stop.reason, 'entry')
  check('nothing has run yet', entry.output, '')
  assert('the breakpoint was accepted', entry.breakpoints.some((bp) => bp.line === 11 && bp.verified),
    JSON.stringify(entry.breakpoints))

  const first = await session.command('continue')
  check('continue stops at the breakpoint', first.stop.reason, 'breakpoint')
  check('on the line it was set on', first.stop.line, 11)
  check('the first time round, total is 0', local(first, 'total'), '0')
  check('and i is 0', local(first, 'i'), '0')

  const second = await session.command('continue')
  check('the breakpoint fires again on the next iteration', second.stop.reason, 'breakpoint')
  check('total has taken i', local(second, 'total'), '0')
  check('i has advanced', local(second, 'i'), '1')

  const third = await session.command('continue')
  check('and again', local(third, 'i'), '2')
  check('total accumulated', local(third, 'total'), '1')

  /*
   * The claim Part 9 was built for, measured rather than asserted vaguely:
   * three steps back from the third breakpoint hit reaches the same line on the
   * PREVIOUS iteration, with the locals restored to what they were then. Not
   * a re-run — the same VM, undoing.
   */
  await session.command('stepBack')
  await session.command('stepBack')
  const back = await session.command('stepBack')
  check('stepping back reaches the same line again', back.stop.line, 11)
  check('on the previous iteration, i is one lower', local(back, 'i'), '1')
  check('and total has un-accumulated', local(back, 'total'), '0')

  const frames = first.frames
  check('the stack is one frame of <main>', frames.map((frame) => frame.name), ['<main>'])
  check('and it names the file', frames[0].source.path, 'loop.bcc')

  const cleared = await session.setBreakpoints([])
  check('clearing breakpoints leaves the machine where it was', cleared.stop.line, back.stop.line)
  check('and reports none armed', cleared.breakpoints.length, 0)

  const done = await session.command('continue')
  check('with nothing armed, continue runs to the end', done.finished, true)
  check('and the program printed its answer', done.output, '10\n')
  check('a program that ended has no stack', done.frames, [])

  const after = await session.command('stepBack')
  check('and gets it back the moment it steps backwards', after.frames.length, 1)
  check('with the answer still in scope', local(after, 'total'), '10')

  session.close()
}

console.log('\n--- stepping out of a call, over the real message channel ---')
{
  /*
   * `fib.bcc` recurses, so it is the one example where the stack has more than
   * one frame — and the frame ids the UI hands back have to keep meaning the
   * same frame across a step. Line 9 is `return n;` inside `fib`.
   */
  const session = openDebugSession(readFileSync(join(examples, 'fib.bcc'), 'utf8'), 'fib.bcc', [9])
  await session.next()

  const inside = await session.command('continue')
  check('it stops inside the call', inside.stop.line, 9)
  check('with the callee innermost', inside.frames.map((frame) => frame.name), ['fib', '<main>'])

  const out = await session.command('stepOut')
  check('stepping out leaves the callee', out.frames.map((frame) => frame.name), ['<main>'])
  check('back at the call site', out.stop.line, 17)

  session.close()
}

console.log('')
if (failures > 0) {
  console.log(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
