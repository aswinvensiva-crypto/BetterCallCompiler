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
 *   7. Navigation is answered by the same daemon: go-to-definition lands on the
 *      declaration, references follow symbol identity across a shadowing
 *      boundary, and a rename plans every occurrence and nothing else.
 *   8. A query carrying an overlay changes what the NEXT query sees, and emits
 *      no diagnostics pass while doing it. That separation is the fix for the
 *      freshness hazard: `openDocument` conflates "this is the text now" with
 *      "please re-check", which is why the renderer debounces it 300ms and
 *      therefore why an interactive answer would otherwise be a third of a
 *      second stale.
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

/**
 * Two `count`s, one shadowing the other, and one function.
 *
 * Written on purpose so a text search gets the wrong answer: the inner `count`
 * on lines 7-8 and the outer one on lines 1, 2 and 10 are spelled identically
 * and are different symbols. Anything matching on the NAME reports six hits for
 * either; matching on symbol identity reports four and two.
 */
const NAVIGABLE = [
  'let count = 0;',            // 1
  'count = count + 1;',        // 2
  'fn bump(step: int) -> int {', // 3
  '  return step + 1;',        // 4
  '}',                         // 5
  'if true {',                 // 6
  '  let count = 99;',         // 7
  '  print count;',            // 8
  '}',                         // 9
  'print bump(count);',        // 10
  ''
].join('\n')

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

  /* --- 7. navigation, answered by the daemon that has the resolution ------ */

  writeFileSync(join(root, 'examples', 'nav.bcc'), NAVIGABLE, 'utf8')
  worker.postMessage({ type: 'filesChanged', changed: ['examples/nav.bcc'], removed: [] })
  await next(worker, 'diagnostics')

  /** Offset of the `nth` occurrence of `needle` in NAVIGABLE, 0-based. */
  const offsetOf = (needle, nth = 0) => {
    let index = -1
    for (let seen = 0; seen <= nth; seen++) {
      index = NAVIGABLE.indexOf(needle, index + 1)
      if (index < 0) throw new Error(`no occurrence ${nth} of ${needle}`)
    }
    return index
  }

  let queryId = 0
  const ask = async (kind, offset, extra = {}) => {
    const requestId = ++queryId
    const answered = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.off('message', onMessage)
        reject(new Error(`timed out waiting for query ${requestId}`))
      }, 15_000)
      const onMessage = (message) => {
        if (message?.type !== 'queryResult' || message.requestId !== requestId) return
        clearTimeout(timer)
        worker.off('message', onMessage)
        resolve(message.result)
      }
      worker.on('message', onMessage)
    })
    worker.postMessage({
      type: 'query',
      requestId,
      kind,
      relativePath: 'examples/nav.bcc',
      offset,
      newName: null,
      overlay: null,
      ...extra
    })
    return await answered
  }

  console.log('\n--- navigation ---')

  const definition = await ask('definition', offsetOf('count', 2))
  check(
    'a read resolves to its declaration',
    definition.locations.map((l) => `${l.range.startLine}:${l.range.startColumn}`),
    ['1:5']
  )

  const callDefinition = await ask('definition', offsetOf('bump', 1))
  check('a call resolves to the function', callDefinition.locations[0].range.startLine, 3)

  const absent = await ask('definition', offsetOf('true'))
  check('a keyword resolves to nothing', absent.locations.length, 0)

  // The claim that makes this more correct than a text search. Six `count`s in
  // the file; four belong to the outer symbol (its declaration, the store and
  // the read on line 2, and the argument on line 10) and two to the inner one.
  // No rule in the navigation code says so — the symbols simply are not the
  // same object.
  const outer = await ask('references', offsetOf('count'))
  check(
    'the outer count has four references',
    outer.locations.map((l) => l.range.startLine),
    [1, 2, 2, 10]
  )
  check('and the answer is complete', outer.truncated, false)

  const inner = await ask('references', offsetOf('count', 3))
  check(
    'the shadowing count has its own two',
    inner.locations.map((l) => l.range.startLine),
    [7, 8]
  )

  const plan = await ask('rename', offsetOf('count', 3))
  check('rename pre-fills the name under the cursor', plan.placeholder, 'count')
  check('and nothing is rewritten until a name is given', plan.files.length, 0)

  const renamed = await ask('rename', offsetOf('count', 3), { newName: 'inner' })
  check(
    'the rename touches only the shadowed occurrences',
    renamed.files[0].edits.map((edit) => edit.range.startLine),
    [8, 7]
  )
  check('descending, so applying in order cannot move the later ranges', renamed.files[0].edits.map((e) => e.range.startLine), [8, 7])

  const rejected = await ask('rename', offsetOf('count', 3), { newName: 'while' })
  check('a keyword is refused by the lexer, not by a regex', rejected.error !== null, true)
  check('and no edits come back with it', rejected.files.length, 0)

  const outline = await ask('documentSymbols', 0)
  check(
    'the outline lists the declarations a reader would expect',
    outline.symbols.map((symbol) => `${symbol.kind} ${symbol.name}${symbol.detail}`),
    ['variable count: int', 'function bump(step: int) -> int', 'variable count: int']
  )

  const hover = await ask('hover', offsetOf('step', 1))
  check('hover names the parameter and its type', hover.contents, '```bcc\nparameter step: int\n```')

  /* --- 8. a query's overlay is adopted without triggering a check --------- */

  console.log('\n--- a query carrying the live buffer ---')

  // The renderer debounces `openDocument` by 300ms because every push triggers
  // a re-check. An interactive query cannot wait for that and must not pay for
  // it, so it carries the buffer and the daemon adopts it WITHOUT checking.
  const silence = nothingWithin(worker, 'diagnostics', 1_200)
  const withOverlay = await ask('definition', 4, {
    overlay: { content: 'let renamedInBuffer = 1;\nprint renamedInBuffer;\n', version: 50 },
    offset: 'let renamedInBuffer = 1;\nprint renamedInBuffer;\n'.indexOf('renamedInBuffer', 25)
  })
  check('the answer describes the buffer, not the file on disk', withOverlay.locations[0].range.startColumn, 5)
  check('and no diagnostics pass was emitted for it', await silence, null)

  // The overlay persists, so the NEXT query — carrying nothing — still sees it.
  const afterwards = await ask('documentSymbols', 0)
  check(
    'the buffer is what the daemon now holds',
    afterwards.symbols.map((symbol) => symbol.name),
    ['renamedInBuffer']
  )

  // And an out-of-order overlay is discarded rather than overwriting a newer one.
  const stale = await ask('documentSymbols', 0, {
    overlay: { content: 'let stale = 1;\n', version: 3 }
  })
  check('a lower version is ignored', stale.symbols.map((s) => s.name), ['renamedInBuffer'])

  /* --- 9. a query must not swallow the check the push would have done ----- */

  console.log('\n--- a query between two pushes ---')

  // The regression an E2E found, and the reason a query cannot simply adopt an
  // overlay and stop. `setInput` reports a change exactly ONCE, and
  // `openDocument` decides whether to check from that answer — so a query
  // carrying the new text, followed by the debounced push carrying the same
  // text, leaves the push looking like a no-op. The buffer is current, the
  // navigation answers are current, and the squiggles are from two edits ago.
  const BROKEN_BUFFER = 'let oops = ;\n'

  // The query moves the daemon's copy of the file, without checking.
  const noPassForTheQuery = nothingWithin(worker, 'diagnostics', 800)
  await ask('documentSymbols', 0, { overlay: { content: BROKEN_BUFFER, version: 60 } })
  check('still no pass for the query itself', await noPassForTheQuery, null)

  // The debounced push then arrives carrying the SAME text.
  worker.postMessage({
    type: 'openDocument',
    relativePath: 'examples/nav.bcc',
    content: BROKEN_BUFFER,
    version: 60
  })
  const afterPush = await next(worker, 'diagnostics', 5_000)
  check(
    'the push still produces the check the query deferred',
    fileIn(afterPush, 'examples/nav.bcc').diagnostics.map((d) => d.code),
    ['BCC0004']
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
