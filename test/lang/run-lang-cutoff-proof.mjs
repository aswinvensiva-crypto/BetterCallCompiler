import { Worker } from 'node:worker_threads'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Proof that BCC Part 12's claim is real, against the REAL built worker:
 * editing one function's body re-lowers that function and no other, and the
 * passes on every untouched function are served from memo.
 *
 * `incremental.test.ts` already proves the pure canonical-string logic in
 * isolation. This is the other half — that `lang-worker.ts` actually wires
 * `Q_LOWER`/`Q_IR`/`Q_SSA`/`Q_PASSES` the way it claims to, observed the only
 * way that can be trusted: by asking the real engine, through the real
 * `observatory` request, and reading what its own trace says happened to
 * each function's query keys. Same reason `test/query/run-cutoff-proof.mjs`
 * exists for the TypeScript daemon rather than trusting the unit tests alone.
 *
 * The fixture is deliberately shaped so the strongest form of the claim is the
 * one under test: `f` is declared BEFORE `g`, so editing `g` cannot move even
 * one byte of `f`'s own span. If that case did not validate cleanly, nothing
 * about position tracking could excuse it.
 */

const WORKER = join(fileURLToPath(new URL('../../', import.meta.url)), 'out/main/lang-worker.js')
const FILE = 'examples/two.bcc'

const STATE_SAME_SIGNATURE = [
  'fn f() -> int {',
  '  return g(1);',
  '}',
  '',
  'fn g(a: int) -> int {',
  '  return a + 1;',
  '}',
  ''
].join('\n')

/** `g`'s body changes; its signature — the only thing `f` can see — does not. */
const STATE_BODY_EDITED = [
  'fn f() -> int {',
  '  return g(1);',
  '}',
  '',
  'fn g(a: int) -> int {',
  '  return a + 2;',
  '}',
  ''
].join('\n')

/**
 * `g`'s return type changes from `int` to `unit` — the one edit that must not
 * leave `f` cut off, and one that visibly changes what `f` lowers to: `return
 * g(1);` no longer has a value to return, so the operand `lower.ts` emits for
 * it turns from a real SSA value into a poisoned constant. An arity-only
 * change was tried here first and did NOT move `f`'s generated code at all —
 * the call site lowers the same argument list either way, so the mismatch is
 * purely a type-checker complaint, not something codegen for the CALLER can
 * see. That is not a bug: the firewall still re-lowers `f` (see the
 * `lowerInput` assertion below), and the engine's OWN cutoff at the `ir:`
 * level is what correctly stops SSA and the passes from re-running on IR that
 * came out identical. This fixture is the one case where the callee's
 * signature actually reaches the caller's shape, so a real regression there
 * has something to break against.
 */
const STATE_SIGNATURE_EDITED = [
  'fn f() -> int {',
  '  return g(1);',
  '}',
  '',
  'fn g(a: int) -> unit {',
  '  print a;',
  '}',
  ''
].join('\n')

function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'bcc-cutoff-'))
  mkdirSync(join(root, 'examples'), { recursive: true })
  writeFileSync(join(root, FILE), STATE_SAME_SIGNATURE, 'utf8')
  return root
}

/**
 * Waits for the next message of `type`, optionally matching `filter`.
 *
 * The filter is what makes this safe against `boot`'s own cold-index pass and
 * the ordinary `check()` pass every `openDocument` triggers: both post a
 * `'pass'` message, same as an observatory request does, and message delivery
 * across a worker thread is asynchronous enough that a listener attached AFTER
 * `await`ing an unrelated message can still receive one that was posted
 * earlier. Matching only on `type` let a stray pass from a previous step
 * answer for the wrong one; matching on `reason`/`requestId` too does not.
 */
function next(worker, type, { timeoutMs = 15_000, filter } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`timed out waiting for a "${type}" message`))
    }, timeoutMs)

    const onMessage = (message) => {
      if (message?.type === 'failure') {
        cleanup()
        reject(new Error(`worker failure: ${message.detail}`))
        return
      }
      if (message?.type !== type) return
      if (filter !== undefined && !filter(message)) return
      cleanup()
      resolve(message)
    }

    function cleanup() {
      clearTimeout(timer)
      worker.off('message', onMessage)
    }

    worker.on('message', onMessage)
  })
}

const failures = []

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`
  )
  if (!ok) failures.push(label)
}

function eventFor(pass, key) {
  return pass.events.find((event) => event.key === key)
}

const root = makeWorkspace()
const worker = new Worker(WORKER)
let requestId = 0

async function askObservatory() {
  const id = ++requestId
  const passPromise = next(worker, 'pass', { filter: (m) => m.pass.reason === 'observatory' })
  const resultPromise = next(worker, 'observatoryResult', { filter: (m) => m.requestId === id })
  worker.postMessage({ type: 'observatory', requestId: id, relativePath: FILE, overlay: null })
  const [pass, result] = await Promise.all([passPromise, resultPromise])
  check('the observatory answer correlates with its request', result.requestId, id)
  return pass.pass
}

async function editTo(content) {
  worker.postMessage({ type: 'openDocument', relativePath: FILE, content, version: ++requestId })
  await next(worker, 'diagnostics')
}

try {
  const indexedPromise = next(worker, 'indexed')
  const firstDiagnostics = next(worker, 'diagnostics')
  worker.postMessage({ type: 'boot', workspaceRoot: root })
  await indexedPromise
  await firstDiagnostics

  /* --- 1. the first ask: everything is new -------------------------------- */

  const cold = await askObservatory()
  check('three functions in the file, main included', cold.requested, 3)
  check('language is reported as bcc, for the merged panel', cold.language, 'bcc')
  check('reason names the observatory, not a check', cold.reason, 'observatory')
  check(
    'nothing was cached yet, so every function is recomputed',
    cold.recomputed,
    cold.requested
  )
  check(
    'f is lowered on the first ask',
    eventFor(cold, `ir:${FILE}#f`)?.outcome,
    'miss'
  )
  check(
    'g is lowered on the first ask',
    eventFor(cold, `ir:${FILE}#g`)?.outcome,
    'miss'
  )

  /* --- 2. g's body changes; f's own text and position do not -------------- */

  await editTo(STATE_BODY_EDITED)
  const afterBody = await askObservatory()

  check('still three functions', afterBody.requested, 3)
  check(
    'only g needed lowering again',
    afterBody.recomputed,
    1
  )
  check(
    'f and <main> were both served from memo',
    afterBody.reused,
    2
  )
  check(
    'f\'s IR was never recomputed — lowerFunction was not called for it',
    eventFor(afterBody, `ir:${FILE}#f`)?.outcome,
    'validated'
  )
  check(
    'f\'s SSA was never recomputed either',
    eventFor(afterBody, `ssa:${FILE}#f`)?.outcome,
    'validated'
  )
  check(
    'f\'s passes were served from memo, not re-run',
    eventFor(afterBody, `pass:${FILE}#f`)?.outcome,
    'validated'
  )
  check(
    'the firewall itself still re-ran (cheap), and found nothing changed for f',
    eventFor(afterBody, `lowerInput:${FILE}#f`)?.outcome,
    'cutoff'
  )
  check(
    'g, the function actually edited, WAS recomputed',
    eventFor(afterBody, `ir:${FILE}#g`)?.outcome,
    'recomputed'
  )

  /* --- 3. g's SIGNATURE changes — the one edit f must not be cut off from -- */

  await editTo(STATE_SIGNATURE_EDITED)
  const afterSignature = await askObservatory()

  check(
    'f depends on g only through what it calls, and that changed — f is recomputed',
    eventFor(afterSignature, `ir:${FILE}#f`)?.outcome,
    'recomputed'
  )
  check(
    'the firewall correctly saw the signature move',
    eventFor(afterSignature, `lowerInput:${FILE}#f`)?.outcome,
    'recomputed'
  )
} finally {
  await worker.terminate()
  rmSync(root, { recursive: true, force: true })
}

console.log('')
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('all checks passed')
