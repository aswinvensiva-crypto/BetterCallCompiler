import { Worker } from 'node:worker_threads'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Proof that the daemon answers navigation, measured against the REAL worker.
 *
 * The unit suite drives `compiler-service` through an injected fake worker,
 * which makes correlation and timeouts deterministic and structurally cannot
 * observe any of this: the `ts.LanguageService`, the tsconfig, the module
 * resolution and the offset arithmetic all live on the other side of that seam.
 * So this spawns out/main/compiler-worker.js for real, over a real workspace on
 * disk, and reads what it posts back.
 *
 * Same reason test/query/run-cutoff-proof.mjs, test/lang, test/asar and test/gc
 * exist. Run with:  npm run test:query:nav
 *
 * The claims under test, stated as numbers:
 *
 *   1. Go to definition from `app.ts` resolves INTO `lib.ts`. This is the whole
 *      justification for the round trip: Monaco's bundled worker has no
 *      tsconfig and no module resolution, so it cannot follow `./lib` at all
 *      and its answer here is empty by construction.
 *   2. Find all references is whole-program, not open-files: a symbol declared
 *      in `lib.ts` and used in two other files reports all three.
 *   3. A definition in `lib.d.ts` or under node_modules is DROPPED rather than
 *      sent, because the renderer keys models on a workspace-relative path and
 *      cannot open one that escapes the root.
 *   4. An overlay on the request changes the answer, and emits no pass.
 *   5. An interactive query issued while a check is running is answered, and
 *      the wait is printed rather than asserted. For a check large enough to
 *      defer its tail (see check-ledger.ts), the query is answered without
 *      waiting for the deferred part to finish — `scheduleDrain` yields to a
 *      queued query between every background slice, unconditionally, not
 *      only when the cancellation flag is raised.
 *   6. With the cancellation flag raised, that check STOPS: the interrupted
 *      pass reports `settled: false`, publishes only what it finished, and
 *      publishes NO empty diagnostic set for a file it never reached. That last
 *      one is the whole hazard — a cancellation mistaken for an ordinary
 *      failure returns [], the clean sweep reads it as "now clean", and every
 *      squiggle in the file disappears.
 *   7. The work comes back. A cancelled pass owes its remaining files and a
 *      resumed pass delivers them, so the diagnostics converge rather than
 *      being silently dropped.
 *   8. A rename reaches every file that mentions the symbol — including ones
 *      nobody has opened — with each file's edits descending, and REFUSES
 *      rather than half-applying when it would reach outside the workspace.
 *   9. A quick fix comes back for a diagnostic that has one, and no fixes come
 *      back when no diagnostic code is supplied.
 */

const WORKER = join(fileURLToPath(new URL('../../', import.meta.url)), 'out/main/compiler-worker.js')

const LIB = `export interface Greeting {
  readonly text: string
}

export function greet(name: string): Greeting {
  return { text: \`hello \${name}\` }
}
`

const APP = `import { greet } from './lib'

const shown = greet('world')
console.log(shown.text)
`

const OTHER = `import { greet } from './lib'

export const twice = [greet('a'), greet('b')]
`

const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true
  },
  "include": ["src"]
}
`

function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'bcc-nav-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'tsconfig.json'), TSCONFIG, 'utf8')
  writeFileSync(join(root, 'src', 'lib.ts'), LIB, 'utf8')
  writeFileSync(join(root, 'src', 'app.ts'), APP, 'utf8')
  writeFileSync(join(root, 'src', 'other.ts'), OTHER, 'utf8')
  return root
}

/** Resolves when the daemon reports itself idle after the initial walk. */
function waitForIdle(worker, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.off('message', onMessage)
      reject(new Error('timed out waiting for idle'))
    }, timeoutMs)

    const onMessage = (message) => {
      if (message?.type !== 'state' || message.state !== 'idle') return
      clearTimeout(timer)
      worker.off('message', onMessage)
      resolve(message.graph)
    }

    worker.on('message', onMessage)
  })
}

/** Waits for one message of a type, failing loudly on a worker failure. */
function next(worker, type, timeoutMs = 60_000) {
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

/** Resolves null if nothing of that type arrives within `ms` — used to prove silence. */
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
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(actual)}${
      ok ? '' : ` (expected ${JSON.stringify(expected)})`
    }`
  )
  if (!ok) failures.push(label)
}

/**
 * Collects diagnostics batches until one arrives with `settled: true`.
 *
 * `settled` was a literal `true` on every batch the daemon ever sent, which the
 * supervisor accumulates correctly and was therefore fed a constant. A
 * cancelled pass is the first thing that can honestly say false.
 */
function collectUntilSettled(worker, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const files = []
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('timed out waiting for a settled diagnostics batch'))
    }, timeoutMs)

    const onMessage = (message) => {
      if (message?.type !== 'diagnostics') return
      files.push(...message.files)
      if (!message.settled) return
      cleanup()
      resolve({ files, settled: true })
    }

    function cleanup() {
      clearTimeout(timer)
      worker.off('message', onMessage)
    }

    worker.on('message', onMessage)
  })
}

/**
 * Records whether the settled batch or the query answer arrives first.
 *
 * The point of cancellation stated as an order rather than a duration: a
 * wall-time comparison on a check this size measures scheduler noise, while
 * "the answer came out in front of the pass" is exactly the behaviour and is
 * deterministic.
 */
function recordOrder(worker) {
  const seen = []
  const onMessage = (message) => {
    if (message?.type === 'diagnostics' && message.settled) seen.push('settled')
    if (message?.type === 'languageQueryResult') seen.push('answer')
  }
  worker.on('message', onMessage)
  return {
    stop() {
      worker.off('message', onMessage)
      return seen
    }
  }
}

/** Every diagnostics batch posted within a window, in order. */
function collectBatches(worker, ms) {
  return new Promise((resolve) => {
    const batches = []
    const onMessage = (message) => {
      if (message?.type !== 'diagnostics') return
      batches.push({ files: message.files, settled: message.settled })
    }
    worker.on('message', onMessage)
    setTimeout(() => {
      worker.off('message', onMessage)
      resolve(batches)
    }, ms)
  })
}

const root = makeWorkspace()

/** The same shared slot `compiler-service.ts` creates and boots the worker with. */
const cancellationBuffer = new SharedArrayBuffer(4)
const cancellationFlag = new Int32Array(cancellationBuffer)

const worker = new Worker(WORKER)
if (process.env.BCC_TRACE) worker.on('message', (m) => console.log('  [msg]', m.type, m.type === 'diagnostics' ? `files=${m.files.length} settled=${m.settled}` : (m.state ?? m.pass?.reason ?? '')))

let queryId = 0

function ask(kind, relativePath, offset, overlay = null, extras = {}) {
  const requestId = ++queryId
  const answered = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.off('message', onMessage)
      reject(new Error(`timed out waiting for query ${requestId}`))
    }, 60_000)
    const onMessage = (message) => {
      if (message?.type !== 'languageQueryResult' || message.requestId !== requestId) return
      clearTimeout(timer)
      worker.off('message', onMessage)
      resolve(message.result)
    }
    worker.on('message', onMessage)
  })
  worker.postMessage({
    type: 'languageQuery',
    requestId,
    kind,
    relativePath,
    offset,
    overlay,
    newName: null,
    endOffset: offset,
    diagnosticCodes: [],
    ...extras
  })
  return answered
}

/** The offset of the `nth` occurrence of `needle` in `text`, 0-based. */
function offsetOf(text, needle, nth = 0) {
  let index = -1
  for (let seen = 0; seen <= nth; seen++) {
    index = text.indexOf(needle, index + 1)
    if (index < 0) throw new Error(`no occurrence ${nth} of ${needle}`)
  }
  return index
}

try {
  worker.postMessage({ type: 'boot', workspaceRoot: root, cancellation: cancellationBuffer })
  const graph = await waitForIdle(worker)
  console.log(`\nindexed ${graph.fileCount} files, ${graph.edgeCount} edges`)
  console.log(`tsconfig adopted: ${graph.tsconfigRelativePath ?? '(fallback options)'}\n`)

  // The walk builds the graph but checks nothing, so the LanguageService has
  // not been created yet. One check pass first, so the numbers below are about
  // navigation rather than about program construction.
  worker.postMessage({ type: 'filesChanged', changed: ['src/lib.ts'], removed: [] })
  await next(worker, 'pass')

  /* --- 1. the cross-file claim, which is the whole justification ---------- */

  console.log('--- go to definition, across a module boundary ---')

  // `greet` on line 3 of app.ts — the CALL, not the import.
  const callSite = offsetOf(APP, 'greet', 1)
  const definition = await ask('definition', 'src/app.ts', callSite)
  check(
    'a call resolves into the other file',
    definition.locations.map((l) => `${l.relativePath}:${l.range.startLine}:${l.range.startColumn}`),
    ['src/lib.ts:5:17']
  )

  // The import specifier itself resolves to the module, which is the same file.
  const importSite = offsetOf(APP, 'greet')
  const importDefinition = await ask('definition', 'src/app.ts', importSite)
  check(
    'the import name resolves too',
    importDefinition.locations.map((l) => l.relativePath),
    ['src/lib.ts']
  )

  /* --- 2. whole-program references ---------------------------------------- */

  console.log('\n--- find all references, over the whole program ---')

  const declaration = offsetOf(LIB, 'greet')
  const references = await ask('references', 'src/lib.ts', declaration)
  const byFile = {}
  for (const location of references.locations) {
    byFile[location.relativePath] = (byFile[location.relativePath] ?? 0) + 1
  }
  check(
    'every file that mentions it, not just the open ones',
    Object.keys(byFile).sort(),
    ['src/app.ts', 'src/lib.ts', 'src/other.ts']
  )
  // Three: the import specifier and the two calls. The import name IS a
  // reference — renaming the symbol has to move it — which is why the daemon
  // counts it and a naive "calls only" expectation is wrong.
  check('the import and both calls in the third file', byFile['src/other.ts'], 3)
  check('the answer is complete', references.truncated, false)

  /* --- 3. what the renderer could not open is dropped --------------------- */

  console.log('\n--- a definition outside the workspace ---')

  // `console` is declared in lib.dom.d.ts, which lives beside the typescript
  // package. The renderer keys models on a workspace-relative path and
  // `fs:readFile` is confined to the root, so a location it cannot open is
  // worse than none: Monaco turns one result into a jump and two into a peek.
  const consoleSite = offsetOf(APP, 'console')
  const outside = await ask('definition', 'src/app.ts', consoleSite)
  check('dropped rather than sent', outside.locations.length, 0)

  /* --- 4. an overlay changes the answer, and emits no pass ---------------- */

  console.log('\n--- a query carrying the live buffer ---')

  const EDITED = `import { greet } from './lib'

const renamed = greet('world')
console.log(renamed.text)
`
  const silence = nothingWithin(worker, 'pass', 1_500)
  const overlaid = await ask('references', 'src/app.ts', offsetOf(EDITED, 'renamed'), {
    content: EDITED,
    version: 99
  })
  check(
    'the answer describes the buffer, not the file on disk',
    overlaid.locations.map((l) => `${l.relativePath}:${l.range.startLine}`),
    ['src/app.ts:3', 'src/app.ts:4']
  )
  check('and no check pass was emitted for it', await silence, null)

  /* --- 5. how long an answer waits behind a check, uncancelled ------------ */

  console.log('\n--- an interactive query issued during a check ---')

  // The overlay from the step above is still in force and its text is two
  // characters longer, so every offset past line 3 has moved. Dropping it puts
  // the daemon back on what is on disk, which is what `callSite` indexes into.
  worker.postMessage({ type: 'closeDocument', relativePath: 'src/app.ts' })

  // A workspace big enough for a check to be worth measuring. One `lib.ts` and
  // FANOUT importers means a signature edit invalidates all of them, which is
  // the shape that puts a real check in front of a keystroke.
  const FANOUT = 120
  for (let i = 0; i < FANOUT; i++) {
    writeFileSync(
      join(root, 'src', `dep${i}.ts`),
      `import { greet } from './lib'\n\nexport const value${i} = greet('${i}')\n`,
      'utf8'
    )
  }
  worker.postMessage({
    type: 'filesChanged',
    changed: Array.from({ length: FANOUT }, (_, i) => `src/dep${i}.ts`),
    removed: []
  })
  await collectUntilSettled(worker)

  const editLib = (parameterType) =>
    writeFileSync(
      join(root, 'src', 'lib.ts'),
      `export interface Greeting {\n  readonly text: string\n}\n\n` +
        `export function greet(name: ${parameterType}): Greeting {\n` +
        '  return { text: `hello ${String(name)}` }\n}\n',
      'utf8'
    )

  // `port.on('message')` calls the worker's handler synchronously within one
  // pass — but a check this size (well above `SMALL_PASS_FILES`) is not one
  // pass any more. Its tail is deferred into the ledger and drained as
  // background `'idle'` passes, and `scheduleDrain` yields with `setImmediate`
  // between every slice specifically so a queued interactive query is
  // answered before the next slice starts. That yield is unconditional — it
  // does not consult the cancellation flag — so for a pass this large the
  // query is NOT expected to wait behind the whole thing even here, with no
  // flag raised. (A pass small enough to stay under the threshold still runs
  // as one synchronous block, and a query behind THAT genuinely queues — this
  // fan-out is deliberately sized past the threshold to exercise deferral.)
  editLib('string')
  const patientOrder = recordOrder(worker)
  const uncancelledAt = Date.now()
  worker.postMessage({ type: 'filesChanged', changed: ['src/lib.ts'], removed: [] })
  const patient = await ask('definition', 'src/app.ts', callSite)
  const uncancelledMs = Date.now() - uncancelledAt

  check('it is answered rather than dropped', patient.locations.length > 0, true)
  // The ORDER, not the clock. A wall-time comparison on a check this size is
  // measuring noise; what is structural is that the query is answered without
  // waiting for the deferred tail to finish draining — `settled` (which now
  // honestly reports only once the ledger is fully empty, see
  // compiler-worker.ts) has not fired by the time the answer comes back.
  check('the answer is not held behind the deferred tail', patientOrder.stop(), ['answer'])
  console.log(`      waited ${uncancelledMs} ms behind a ${FANOUT + 3}-file check`)

  /* --- 6. the same query, with the flag raised ---------------------------- */

  console.log('\n--- the same query, cancelling the check ---')

  editLib('number')
  const impatientOrder = recordOrder(worker)
  const cancelledAt = Date.now()
  worker.postMessage({ type: 'filesChanged', changed: ['src/lib.ts'], removed: [] })
  Atomics.store(cancellationFlag, 0, 1)
  const impatient = await ask('definition', 'src/app.ts', callSite)
  const cancelledMs = Date.now() - cancelledAt

  check('still answered, and still correct', impatient.locations[0]?.relativePath, 'src/lib.ts')
  console.log(`      waited ${cancelledMs} ms with the flag raised`)
  // The claim, stated as an order rather than a duration: the answer now comes
  // out IN FRONT of the pass instead of behind it.
  check('the answer overtakes the pass', impatientOrder.stop()[0], 'answer')
  check('the worker stood the flag down to answer', Atomics.load(cancellationFlag, 0), 0)

  const afterCancel = await collectUntilSettled(worker)
  check(
    'and the work came back rather than being dropped',
    afterCancel.files.filter((file) => file.diagnostics.length > 0).length > FANOUT / 2,
    true
  )

  /* --- 7. the erasure a cancelled pass must not cause --------------------- */

  console.log('\n--- a cancellation landing PART-WAY through a pass ---')

  // The hazard needs the pass to get some files done and then stop. Raising the
  // flag with the message loses the race — `synchronizeHostData` throws on the
  // very first file, `produced` is empty and nothing is published, which proves
  // nothing about the sweep. Raising it on a timer lands it mid-pass, where
  // `nowDirty` is a PARTIAL answer and sweeping against it would publish empty
  // sets for files nobody looked at.
  editLib('boolean')
  const batches = collectBatches(worker, 6_000)
  worker.postMessage({ type: 'filesChanged', changed: ['src/lib.ts'], removed: [] })
  setTimeout(() => {
    Atomics.store(cancellationFlag, 0, 1)
    void ask('definition', 'src/app.ts', callSite)
  }, 20)
  const collected = await batches

  const partial = collected.find((batch) => batch.settled === false)
  check('an interrupted pass says so instead of claiming to be settled', partial !== undefined, true)
  check('and it published what it did finish', (partial?.files ?? []).length > 0, true)

  // Every file in that batch was actually checked, so one reported CLEAN there
  // is either genuinely clean or a casualty of `catch { return [] }` swallowing
  // the cancellation — which the clean sweep then reads as "now clean" and
  // every squiggle in the file disappears.
  const erased = (partial?.files ?? []).filter(
    (file) => file.relativePath.startsWith('src/dep') && file.diagnostics.length === 0
  )
  check('no dependent was published as clean by a cancelled pass', erased.length, 0)

  const converged = new Map()
  for (const batch of collected) {
    for (const file of batch.files) converged.set(file.relativePath, file.diagnostics.length)
  }
  check(
    'the resumed pass delivers the rest',
    [...converged.values()].filter((count) => count > 0).length > FANOUT / 2,
    true
  )
  check('and the last batch settles', collected[collected.length - 1]?.settled, true)


  /* --- 8. rename, across every file that mentions the symbol -------------- */

  console.log('\n--- rename ---')

  editLib('string')
  worker.postMessage({ type: 'filesChanged', changed: ['src/lib.ts'], removed: [] })
  await collectUntilSettled(worker)

  const declaration2 = offsetOf(LIB, 'greet')
  const plan = await ask('rename', 'src/lib.ts', declaration2)
  check('the box pre-fills with the symbol under the caret', plan.placeholder, 'greet')
  check('and nothing is rewritten until a name is given', plan.files.length, 0)

  const renamed = await ask('rename', 'src/lib.ts', declaration2, null, { newName: 'welcome' })
  check('every file that mentions it gets edits', renamed.files.length, FANOUT + 3)
  check('the declaration among them', renamed.files.some((f) => f.relativePath === 'src/lib.ts'), true)
  check('and a file nobody opened', renamed.files.some((f) => f.relativePath === 'src/dep7.ts'), true)
  check('no error', renamed.error, null)

  // Descending within each file, so applying in order cannot move a range not
  // yet applied. `other.ts` has three occurrences, which is enough to tell a
  // sort from an accident.
  const otherEdits = renamed.files.find((f) => f.relativePath === 'src/other.ts')?.edits ?? []
  const startLines = otherEdits.map((edit) => edit.range.startLine)
  check(
    'edits within a file come back descending',
    [...startLines].every((line, i) => i === 0 || line <= startLines[i - 1]),
    true
  )

  // Renaming something declared in a library must be REFUSED, not partially
  // applied: dropping the locations outside the workspace would leave a program
  // that compiles nowhere with nothing having said so.
  const libraryRename = await ask('rename', 'src/app.ts', offsetOf(APP, 'console'), null, {
    newName: 'consoul'
  })
  check('a library symbol is refused', libraryRename.error !== null, true)
  check('with no edits attached', libraryRename.files.length, 0)

  /* --- 9. quick fixes ----------------------------------------------------- */

  console.log('\n--- code actions ---')

  const TYPO = `import { greet } from './lib'\n\nexport const shown = gret('world')\n`
  writeFileSync(join(root, 'src', 'app.ts'), TYPO, 'utf8')
  worker.postMessage({ type: 'filesChanged', changed: ['src/app.ts'], removed: [] })
  const typo = await collectUntilSettled(worker)

  const appDiagnostics = typo.files.find((file) => file.relativePath === 'src/app.ts')?.diagnostics
  check('the typo is reported', (appDiagnostics ?? []).length > 0, true)

  const codes = (appDiagnostics ?? []).map((d) => Number(d.code.replace('TS', '')))
  const typoAt = offsetOf(TYPO, 'gret')
  const fixes = await ask('codeActions', 'src/app.ts', typoAt, null, {
    endOffset: typoAt + 4,
    diagnosticCodes: codes
  })

  check('a fix is offered', fixes.actions.length > 0, true)
  // TypeScript's own wording, which is more specific than anything this could
  // invent: it names the symbol it thinks was meant.
  check(
    'and it is the spelling fix, naming the symbol that exists',
    fixes.actions.map((action) => action.title),
    ["Change spelling to 'greet'"]
  )
  check(
    'its edits name a real file',
    fixes.actions[0]?.edits.every((file) => file.relativePath.startsWith('src/')),
    true
  )

  // A fix is a fix FOR something. Asking with no codes has to return nothing
  // rather than every refactoring TypeScript can imagine.
  const unprompted = await ask('codeActions', 'src/app.ts', typoAt, null, {
    endOffset: typoAt + 4,
    diagnosticCodes: []
  })
  check('no codes, no fixes', unprompted.actions.length, 0)
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
