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
 *   5. An interactive query issued while a check is running is answered — the
 *      harness prints how long it waited rather than asserting it is fast,
 *      because `port.on('message')` dispatches synchronously and the answer
 *      genuinely queues behind the check. That number is what A4's cancellation
 *      flag is measured against.
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

const root = makeWorkspace()
const worker = new Worker(WORKER)

let queryId = 0

function ask(kind, relativePath, offset, overlay = null) {
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
  worker.postMessage({ type: 'languageQuery', requestId, kind, relativePath, offset, overlay })
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
  worker.postMessage({ type: 'boot', workspaceRoot: root })
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

  /* --- 5. how long an answer waits behind a check ------------------------- */

  console.log('\n--- an interactive query issued during a check ---')

  // The overlay from the step above is still in force and its text is two
  // characters longer, so every offset past line 3 has moved. Dropping it puts
  // the daemon back on what is on disk, which is what `callSite` indexes into.
  worker.postMessage({ type: 'closeDocument', relativePath: 'src/app.ts' })

  // A workspace big enough for the check to be worth measuring. One `lib.ts`
  // and FANOUT importers means a signature edit invalidates all of them, which
  // is the shape that makes a check take long enough to sit in front of a
  // keystroke.
  const FANOUT = 60
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
  await next(worker, 'pass')

  // `port.on('message')` calls the worker's handler synchronously, so nothing
  // is delivered while a check is running and no priority queue inside the
  // worker could reorder it. This MEASURES the wait rather than asserting it is
  // small: the number is the baseline A4's cancellation flag has to beat, and
  // pretending it is already small would make that comparison meaningless.
  writeFileSync(join(root, 'src', 'lib.ts'), `${LIB}\nexport const marker = 1\n`, 'utf8')

  const startedAt = Date.now()
  worker.postMessage({ type: 'filesChanged', changed: ['src/lib.ts'], removed: [] })
  const answer = await ask('definition', 'src/app.ts', callSite)
  const waitedMs = Date.now() - startedAt

  check('it is answered rather than dropped', answer.locations.length > 0, true)
  check('and the answer is still correct', answer.locations[0]?.relativePath, 'src/lib.ts')
  console.log(
    `      waited ${waitedMs} ms behind a ${FANOUT + 3}-file check ` +
      '(A4 target: bounded by one cancellation checkpoint)'
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
