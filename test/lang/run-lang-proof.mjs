import { Worker } from 'node:worker_threads'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Proof that the BCC daemon does what it claims, measured against the REAL
 * worker rather than a fake.
 *
 * `lang-service.test.ts` drives the supervisor through an injected fake worker,
 * which makes restart and heartbeat behaviour deterministic and structurally
 * cannot observe any of this: the walk, the query engine, the lexer, the parser
 * and the clean sweep all live on the other side of that seam. So this harness
 * spawns out/main/lang-worker.js for real, over a real workspace on disk, and
 * reads what it posts back.
 *
 * Same reason test/query, test/asar and test/gc exist. Run with: npm run test:lang
 *
 * The claims under test, stated as numbers:
 *
 *   1. A workspace with two `.bcc` files indexes both and reports the broken
 *      one only.
 *   2. Fixing a file emits an EMPTY diagnostics array for it. Not "no message" —
 *      empty is the signal that clears the squiggle, and treating it as an
 *      empty batch is how a fixed error keeps its marker forever.
 *   3. An unsaved buffer beats what is on disk, and closing it goes back.
 *   4. A watch event for a file whose bytes did not change costs nothing —
 *      the engine's early exit, which is what makes the pipeline incremental.
 *   5. Deleting a file that had errors clears its row.
 *   6. A type error reaches the editor exactly like a syntax error does, merged
 *      into position order, with no cascade from one mistake.
 */

const WORKER = join(fileURLToPath(new URL('../../', import.meta.url)), 'out/main/lang-worker.js')

const CLEAN = 'fn add(a: int, b: int) -> int {\n  return a + b;\n}\n'
const BROKEN = 'fn add(a: int, b: int) -> int {\n  return a + b\n}\n'

/** Parses cleanly; the type checker is the one that objects. */
const TYPE_ERROR = 'fn add(a: int, b: int) -> int {\n  return a + true;\n}\n'
/** One name nobody declared, used three times. */
const CASCADE = 'print nope + nope * nope;\n'
/** A syntax error on line 1 and a type error on line 2, found by different stages. */
const MIXED = 'let a = 1\nprint true + 1;\n'

function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'bcc-lang-'))
  mkdirSync(join(root, 'examples'), { recursive: true })
  writeFileSync(join(root, 'examples', 'good.bcc'), CLEAN, 'utf8')
  writeFileSync(join(root, 'examples', 'bad.bcc'), BROKEN, 'utf8')
  // A TypeScript file the BCC daemon must ignore completely.
  writeFileSync(join(root, 'ignored.ts'), 'export const x = 1\n', 'utf8')
  return root
}

/** Collects messages until one of `types` arrives, or times out. */
function next(worker, type, timeoutMs = 15_000) {
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
      if (message?.type === type) {
        cleanup()
        resolve(message)
      }
    }

    function cleanup() {
      clearTimeout(timer)
      worker.off('message', onMessage)
    }

    worker.on('message', onMessage)
  })
}

/** Resolves null if nothing arrives — used to prove silence. */
function nothingWithin(worker, type, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      worker.off('message', onMessage)
      resolve(null)
    }, ms)

    const onMessage = (message) => {
      if (message?.type !== type) return
      clearTimeout(timer)
      worker.off('message', onMessage)
      resolve(message)
    }

    worker.on('message', onMessage)
  })
}

const failures = []

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`)
  if (!ok) failures.push(label)
}

const fileIn = (message, relativePath) =>
  message.files.find((file) => file.relativePath === relativePath)

const root = makeWorkspace()
const worker = new Worker(WORKER)

try {
  const indexedPromise = next(worker, 'indexed')
  const firstDiagnostics = next(worker, 'diagnostics')
  worker.postMessage({ type: 'boot', workspaceRoot: root })

  const indexed = await indexedPromise
  console.log(`\nindexed ${indexed.fileCount} .bcc files\n`)

  /* --- 1. it finds only .bcc, and reports only the broken one ------------- */

  check('files walked', indexed.fileCount, 2)

  const cold = await firstDiagnostics
  console.log('--- cold index ---')
  check(
    'both files reported on',
    cold.files.map((file) => file.relativePath).sort(),
    ['examples/bad.bcc', 'examples/good.bcc']
  )
  check('the .ts file is invisible to this daemon', fileIn(cold, 'ignored.ts'), undefined)
  check('clean file has no diagnostics', fileIn(cold, 'examples/good.bcc').diagnostics.length, 0)

  const badDiagnostics = fileIn(cold, 'examples/bad.bcc').diagnostics
  check('broken file has one diagnostic', badDiagnostics.length, 1)
  check('and it is the missing semicolon', badDiagnostics[0].code, 'BCC0003')
  check('reported on the line the statement is on', badDiagnostics[0].startLine, 2)
  check('tagged as ours', badDiagnostics[0].source, 'bcc')

  /* --- 2. fixing it emits an EMPTY set, which is what clears the squiggle -- */

  writeFileSync(join(root, 'examples', 'bad.bcc'), CLEAN, 'utf8')
  worker.postMessage({ type: 'filesChanged', changed: ['examples/bad.bcc'], removed: [] })
  const fixed = await next(worker, 'diagnostics')

  console.log('\n--- after fixing the file ---')
  check('an explicit empty array, not a skipped batch', fileIn(fixed, 'examples/bad.bcc').diagnostics.length, 0)
  check('version advanced, so the batch is not discarded as stale', fileIn(fixed, 'examples/bad.bcc').version > 1, true)

  /* --- 3. an unsaved buffer beats disk ------------------------------------ */

  worker.postMessage({
    type: 'openDocument',
    relativePath: 'examples/good.bcc',
    content: 'let x = ;\n',
    version: 2
  })
  const buffered = await next(worker, 'diagnostics')

  console.log('\n--- an unsaved buffer, with disk still clean ---')
  check(
    'checked from the buffer, not from disk',
    fileIn(buffered, 'examples/good.bcc').diagnostics.map((d) => d.code),
    ['BCC0004']
  )

  worker.postMessage({ type: 'closeDocument', relativePath: 'examples/good.bcc' })
  const closed = await next(worker, 'diagnostics')
  console.log('\n--- buffer closed without saving ---')
  check('back to what is on disk', fileIn(closed, 'examples/good.bcc').diagnostics.length, 0)

  /* --- 4. an unchanged file costs nothing --------------------------------- */

  console.log('\n--- a watch event for a file whose bytes did not change ---')
  // The engine compares before it bumps the revision, so a formatter rewriting
  // identical content or a git checkout touching every mtime does no work and
  // sends no message. Silence is the assertion.
  writeFileSync(join(root, 'examples', 'good.bcc'), CLEAN, 'utf8')
  worker.postMessage({ type: 'filesChanged', changed: ['examples/good.bcc'], removed: [] })
  const quiet = await nothingWithin(worker, 'diagnostics', 1_500)
  check('nothing was posted', quiet, null)

  /* --- 5. deleting a file that had errors clears its row ------------------ */

  writeFileSync(join(root, 'examples', 'bad.bcc'), BROKEN, 'utf8')
  worker.postMessage({ type: 'filesChanged', changed: ['examples/bad.bcc'], removed: [] })
  const dirtyAgain = await next(worker, 'diagnostics')
  check('broken again', fileIn(dirtyAgain, 'examples/bad.bcc').diagnostics.length, 1)

  unlinkSync(join(root, 'examples', 'bad.bcc'))
  worker.postMessage({ type: 'filesChanged', changed: [], removed: ['examples/bad.bcc'] })
  const deleted = await next(worker, 'diagnostics')

  console.log('\n--- the broken file is deleted ---')
  check('an empty set for a file that no longer exists', fileIn(deleted, 'examples/bad.bcc').diagnostics.length, 0)

  /* --- 6. the type checker reaches the editor too -------------------------- */

  // The point of Part 4 landing behind the SAME query pipeline: a type error is
  // not a different kind of thing to the editor, it is another diagnostic with
  // another code.
  writeFileSync(join(root, 'examples', 'good.bcc'), TYPE_ERROR, 'utf8')
  worker.postMessage({ type: 'filesChanged', changed: ['examples/good.bcc'], removed: [] })
  const typed = await next(worker, 'diagnostics')

  console.log('\n--- a type error, not a syntax error ---')
  const typedDiagnostics = fileIn(typed, 'examples/good.bcc').diagnostics
  check('one diagnostic', typedDiagnostics.length, 1)
  check('the operator complains', typedDiagnostics[0].code, 'BCC0013')
  check('reported on line 2', typedDiagnostics[0].startLine, 2)

  // One message per name the user has to fix, and NOT the extra operator errors
  // that would pile on without the poison type.
  writeFileSync(join(root, 'examples', 'good.bcc'), CASCADE, 'utf8')
  worker.postMessage({ type: 'filesChanged', changed: ['examples/good.bcc'], removed: [] })
  const cascade = await next(worker, 'diagnostics')

  console.log('\n--- one mistake does not become five ---')
  check(
    'three name errors and nothing else',
    fileIn(cascade, 'examples/good.bcc').diagnostics.map((d) => d.code),
    ['BCC0008', 'BCC0008', 'BCC0008']
  )

  // Three stages report in their own walk orders. The Problems panel renders in
  // the order it receives, so they have to be merged by position or a type
  // error on line 2 lands above a syntax error on line 1.
  writeFileSync(join(root, 'examples', 'good.bcc'), MIXED, 'utf8')
  worker.postMessage({ type: 'filesChanged', changed: ['examples/good.bcc'], removed: [] })
  const mixed = await next(worker, 'diagnostics')

  console.log('\n--- stages merged in position order ---')
  check(
    'syntax first, then the type error',
    fileIn(mixed, 'examples/good.bcc').diagnostics.map((d) => `${d.startLine}:${d.code}`),
    ['1:BCC0003', '2:BCC0013']
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
