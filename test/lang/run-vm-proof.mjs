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

console.log('')
if (failures > 0) {
  console.log(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
