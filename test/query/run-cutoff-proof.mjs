import { Worker } from 'node:worker_threads'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Proof that the signature cutoff does what it claims, measured against the
 * REAL worker rather than a fake.
 *
 * The unit suite drives compiler-service through an injected fake worker, which
 * makes heartbeat and restart behaviour deterministic and structurally cannot
 * observe any of this: the query engine, the TypeScript LanguageService and the
 * signature hash all live on the other side of that seam. So this harness
 * spawns out/main/compiler-worker.js for real, over a real workspace on disk,
 * and reads the pass messages it emits.
 *
 * Same reason test/asar and test/gc exist. Run with:  npm run test:query
 *
 * The single claim under test, stated as a number: editing a function BODY in a
 * module with a dependent must type-check ONE file, not two. Editing that
 * function's SIGNATURE must type-check both, and produce TS2345 in the
 * dependent. If the first number is ever 2, the cutoff is dead and the feature
 * has silently reverted to what it replaced.
 */

const WORKER = join(fileURLToPath(new URL('../../', import.meta.url)), 'out/main/compiler-worker.js')

const LIB_ORIGINAL = `export function greet(name: string): string {
  return \`hello \${name}\`
}
`

// Identical exported type. Only the returned string literal moves.
const LIB_BODY_EDIT = `export function greet(name: string): string {
  return \`good evening to you, \${name}\`
}
`

// The public surface moves: string -> number.
const LIB_SIGNATURE_EDIT = `export function greet(name: number): string {
  return \`hello \${name}\`
}
`

const APP = `import { greet } from './lib'

console.log(greet('world'))
`

function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'bcc-cutoff-'))
  writeFileSync(join(root, 'lib.ts'), LIB_ORIGINAL, 'utf8')
  writeFileSync(join(root, 'app.ts'), APP, 'utf8')
  return root
}

/** Collects worker output until a pass arrives, or times out. */
function nextPass(worker, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const diagnostics = []
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('timed out waiting for a pass message'))
    }, timeoutMs)

    const onMessage = (message) => {
      if (message?.type === 'diagnostics') diagnostics.push(...message.files)
      if (message?.type === 'failure') {
        cleanup()
        reject(new Error(`worker failure: ${message.detail}`))
        return
      }
      if (message?.type === 'pass') {
        cleanup()
        resolve({ pass: message.pass, diagnostics })
      }
    }

    function cleanup() {
      clearTimeout(timer)
      worker.off('message', onMessage)
    }

    worker.on('message', onMessage)
  })
}

/** Resolves once the worker reports it has finished indexing. */
function waitForIdle(worker, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.off('message', onMessage)
      reject(new Error('timed out waiting for idle'))
    }, timeoutMs)

    const onMessage = (message) => {
      if (message?.type === 'state' && message.state === 'idle') {
        clearTimeout(timer)
        worker.off('message', onMessage)
        resolve(message.graph)
      }
    }

    worker.on('message', onMessage)
  })
}

const failures = []

function check(label, actual, expected) {
  const ok = actual === expected
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : ` (expected ${expected})`}`)
  if (!ok) failures.push(label)
}

const root = makeWorkspace()
const worker = new Worker(WORKER)

try {
  worker.postMessage({ type: 'boot', workspaceRoot: root })
  const graph = await waitForIdle(worker)

  console.log(`\nindexed ${graph.fileCount} files, ${graph.edgeCount} edges in ${graph.lastBuildMs}ms`)
  console.log(`tsconfig adopted: ${graph.tsconfigRelativePath ?? '(fallback options)'}\n`)

  /* --- cold pass: nothing is memoised, so both files must be checked ------- */

  writeFileSync(join(root, 'lib.ts'), LIB_ORIGINAL, 'utf8')
  worker.postMessage({ type: 'filesChanged', changed: ['lib.ts'], removed: [] })
  const cold = await nextPass(worker)

  console.log('--- cold pass (first check of both files) ---')
  check('files requested', cold.pass.requested, 2)
  check('files type-checked', cold.pass.recomputed, 2)
  check('files served from memo', cold.pass.reused, 0)
  // This pass is the one that builds the program and the type checker, so it
  // must not be reported as ordinary typing latency.
  check('reported as the cold pass', cold.pass.reason, 'cold')
  check(
    'errors reported',
    cold.diagnostics.reduce((n, file) => n + file.diagnostics.length, 0),
    0
  )

  /* --- the claim: a body edit must check ONE file --------------------------- */

  writeFileSync(join(root, 'lib.ts'), LIB_BODY_EDIT, 'utf8')
  worker.postMessage({ type: 'filesChanged', changed: ['lib.ts'], removed: [] })
  const body = await nextPass(worker)

  console.log('\n--- body-only edit to lib.ts (app.ts imports it) ---')
  // The invalidation walk still NAMES both files. That is unchanged and correct
  // — what changed is what asking about the second one costs.
  check('files requested', body.pass.requested, 2)
  check('files type-checked', body.pass.recomputed, 1)
  check('files served from memo', body.pass.reused, 1)

  // The pass now records what caused it, not only how much it did.
  check('trigger names the edited file', body.pass.trigger.join(','), 'lib.ts')

  const sigTrace = body.pass.events.find((event) => event.key === 'sig:lib.ts')
  check('sig:lib.ts outcome', sigTrace?.outcome, 'cutoff')
  const appTrace = body.pass.events.find((event) => event.key === 'diag:app.ts')
  check('diag:app.ts outcome', appTrace?.outcome, 'validated')

  /* --- the control: a signature edit MUST check both and find the error ----- */

  writeFileSync(join(root, 'lib.ts'), LIB_SIGNATURE_EDIT, 'utf8')
  worker.postMessage({ type: 'filesChanged', changed: ['lib.ts'], removed: [] })
  const signature = await nextPass(worker)

  console.log('\n--- signature edit to lib.ts (string -> number) ---')
  check('files type-checked', signature.pass.recomputed, 2)
  check('files served from memo', signature.pass.reused, 0)

  const appDiagnostics = signature.diagnostics.find((file) => file.relativePath === 'app.ts')
  const codes = (appDiagnostics?.diagnostics ?? []).map((diagnostic) => diagnostic.code)
  check('TS2345 raised in app.ts, which was never edited', codes.includes('TS2345'), true)

  /* --- and it must clear again ---------------------------------------------- */

  writeFileSync(join(root, 'lib.ts'), LIB_ORIGINAL, 'utf8')
  worker.postMessage({ type: 'filesChanged', changed: ['lib.ts'], removed: [] })
  const reverted = await nextPass(worker)

  console.log('\n--- revert ---')
  const revertedApp = reverted.diagnostics.find((file) => file.relativePath === 'app.ts')
  check('app.ts diagnostics cleared', revertedApp?.diagnostics.length, 0)

  /* --- deleting a file must invalidate whatever imported it ----------------- */

  // The reverse edges live on the node being deleted, so `applyChanges` has to
  // ask who depended on lib.ts BEFORE removing it. When it asked afterwards, the
  // answer was always "nobody": the invalidation set came back holding only
  // lib.ts, which the filter then dropped for no longer existing, and app.ts was
  // never rechecked. Its import silently kept resolving to the file's ghost
  // until some unrelated edit happened to touch it.
  rmSync(join(root, 'lib.ts'))
  worker.postMessage({ type: 'filesChanged', changed: [], removed: ['lib.ts'] })
  const deleted = await nextPass(worker)

  console.log('\n--- lib.ts deleted, while app.ts still imports it ---')
  check('files type-checked', deleted.pass.recomputed, 1)
  const orphaned = deleted.diagnostics.find((file) => file.relativePath === 'app.ts')
  const orphanCodes = (orphaned?.diagnostics ?? []).map((diagnostic) => diagnostic.code)
  check('TS2307 raised in app.ts, which was never edited', orphanCodes.includes('TS2307'), true)
} finally {
  await worker.terminate()
  rmSync(root, { recursive: true, force: true })
}

/* --- a pass bigger than the trace cap must still report its real size ------- */

// The events list is capped so that a cold index over a large workspace does not
// build a 60 000-entry array and structured-clone it across the port. That cap is
// applied on the way IN, so anything counted by walking the array afterwards
// stops counting at the cap — and the pass totals used to be derived that way,
// which meant every pass past roughly 160 files silently understated itself.
//
// 200 files fanning out from one is enough to overrun it: three events per file,
// against a cap of 500.
const wideRoot = mkdtempSync(join(tmpdir(), 'bcc-wide-'))
const WIDE_FILES = 200

writeFileSync(join(wideRoot, 'core.ts'), 'export const core = 1\n', 'utf8')
for (let i = 1; i < WIDE_FILES; i++) {
  writeFileSync(
    join(wideRoot, `f${i}.ts`),
    `import { core } from './core'\n\nexport const v${i} = core + ${i}\n`,
    'utf8'
  )
}

const wideWorker = new Worker(WORKER)

try {
  wideWorker.postMessage({ type: 'boot', workspaceRoot: wideRoot })
  await waitForIdle(wideWorker)

  wideWorker.postMessage({ type: 'filesChanged', changed: ['core.ts'], removed: [] })
  const wide = await nextPass(wideWorker, 120_000)

  console.log(`\n--- ${WIDE_FILES}-file pass, against the split trace budget ---`)
  check('files requested', wide.pass.requested, WIDE_FILES)

  // Totals come from counters rather than from the sample, so they are exact
  // whatever the budget chooses to keep.
  check(
    'recomputed + reused accounts for every requested file',
    wide.pass.recomputed + wide.pass.reused,
    WIDE_FILES
  )

  // The guarantee the split budget exists for: every file the pass was asked
  // about keeps its diag event, so the Why tab can look any of them up.
  //
  // Under a single 500-event cap this fails. checkFiles orders open files first
  // and each file emits three events, so at 200 files the budget runs out around
  // the 166th and the diag events dropped are precisely those of the files the
  // user did NOT edit — the only ones anyone asks "why was this rechecked?"
  // about.
  const diagEvents = wide.pass.events.filter((event) => event.key.startsWith('diag:'))
  check('diag events retained, one per file', diagEvents.length, WIDE_FILES)
  check(
    'every retained diag event names a distinct file',
    new Set(diagEvents.map((event) => event.key)).size,
    WIDE_FILES
  )
} finally {
  await wideWorker.terminate()
  rmSync(wideRoot, { recursive: true, force: true })
}

console.log('')
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('all checks passed')
