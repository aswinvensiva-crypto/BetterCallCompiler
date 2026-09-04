import { Worker } from 'node:worker_threads'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Proof that the interactive daemon answers, against the REAL worker.
 *
 * Everything under test lives on the other side of the supervisor's injected
 * seam: the second `ts.LanguageService`, the tsconfig it adopts, the module
 * resolution that makes cross-file answers possible, and the offset arithmetic.
 * So this spawns out/main/interactive-worker.js over a real workspace on disk.
 *
 * Run with:  npm run test:interactive
 *
 * The claims under test, stated as values:
 *
 *   1. Hover on a symbol imported from another file describes it. Monaco's
 *      bundled worker cannot resolve `./lib` at all, so its answer here is
 *      `any` — this is the whole reason a second type checker is worth its
 *      memory.
 *   2. Member completions after `.` on a value whose TYPE comes from another
 *      file list that type's members, for the same reason.
 *   3. A completion's detail is fetched on demand, one entry at a time, rather
 *      than several thousand signatures crossing the wire per keystroke.
 *   4. Signature help inside a call names the parameters and says which one the
 *      caret is in.
 *   5. The buffer on the request wins over the file on disk, because these are
 *      answered AT a keystroke and the 300ms overlay debounce would make every
 *      one of them describe the file as it was several characters ago.
 */

const WORKER = join(
  fileURLToPath(new URL('../../', import.meta.url)),
  'out/main/interactive-worker.js'
)

const LIB = `export interface Point {
  readonly x: number
  readonly y: number
}

/** Adds two points together. */
export function translate(origin: Point, by: Point): Point {
  return { x: origin.x + by.x, y: origin.y + by.y }
}
`

const APP = `import { translate } from './lib'

const start = { x: 1, y: 2 }
const moved = translate(start, { x: 3, y: 4 })
console.log(moved.)
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
  const root = mkdtempSync(join(tmpdir(), 'bcc-interactive-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'tsconfig.json'), TSCONFIG, 'utf8')
  writeFileSync(join(root, 'src', 'lib.ts'), LIB, 'utf8')
  writeFileSync(join(root, 'src', 'app.ts'), APP, 'utf8')
  return root
}

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

function ask(kind, relativePath, offset, overlay = null, extras = {}) {
  const requestId = ++queryId
  const answered = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.off('message', onMessage)
      reject(new Error(`timed out waiting for query ${requestId}`))
    }, 60_000)
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
    relativePath,
    offset,
    entryName: null,
    entrySource: null,
    overlay,
    ...extras
  })
  return answered
}

const offsetOf = (text, needle, nth = 0) => {
  let index = -1
  for (let seen = 0; seen <= nth; seen++) {
    index = text.indexOf(needle, index + 1)
    if (index < 0) throw new Error(`no occurrence ${nth} of ${needle}`)
  }
  return index
}

try {
  const indexed = next(worker, 'indexed')
  worker.postMessage({ type: 'boot', workspaceRoot: root })
  const { fileCount } = await indexed
  console.log(`\nindexed ${fileCount} files\n`)
  check('the walk found both source files', fileCount, 2)

  /* --- 1. hover, across a module boundary --------------------------------- */

  console.log('--- hover ---')

  const hover = await ask('hover', 'src/app.ts', offsetOf(APP, 'translate', 1))
  // `(alias)`, and the doc comment from the OTHER file. TypeScript reports a
  // call site that goes through an import as an alias, which is what VS Code
  // shows too — and it can only say any of it because `./lib` resolved.
  check(
    'the imported function is described by its real signature, doc comment and all',
    hover.contents,
    '```typescript\n(alias) translate(origin: Point, by: Point): Point\nimport translate\n```\n\nAdds two points together.'
  )
  check('and it is anchored on the call', hover.range?.startLine, 4)

  // The thing Monaco's worker cannot do. `moved` has no annotation; its type
  // comes from a return type in another file, so answering `Point` at all
  // requires having resolved `./lib`.
  const inferred = await ask('hover', 'src/app.ts', offsetOf(APP, 'moved'))
  check(
    'a type inferred from another file is named, not guessed',
    inferred.contents?.includes('const moved: Point'),
    true
  )

  /* --- 2. member completions from a type declared elsewhere --------------- */

  console.log('\n--- completions ---')

  // Immediately after `moved.` on the last line.
  const afterDot = offsetOf(APP, 'moved.') + 'moved.'.length
  const members = await ask('completions', 'src/app.ts', afterDot)
  check(
    'the members are the interface declared in the other file',
    members.items.map((item) => item.label).sort(),
    ['x', 'y']
  )
  check('and they are typed as properties', members.items[0]?.kind, 'property')

  /* --- 3. detail is fetched one entry at a time --------------------------- */

  const detail = await ask('completionDetail', 'src/app.ts', afterDot, null, {
    entryName: 'x'
  })
  check('the highlighted entry carries its own signature', detail.detail, '(property) Point.x: number')

  /* --- 4. signature help -------------------------------------------------- */

  console.log('\n--- signature help ---')

  // Inside `translate(start, ...)`, after the comma — the second parameter.
  const secondArgument = offsetOf(APP, 'translate(start, ') + 'translate(start, '.length
  const help = await ask('signatureHelp', 'src/app.ts', secondArgument)
  check('one overload', help.signatures.length, 1)
  check(
    'labelled the way it is written',
    help.signatures[0]?.label,
    'translate(origin: Point, by: Point): Point'
  )
  check(
    'with both parameters named',
    help.signatures[0]?.parameters.map((parameter) => parameter.label),
    ['origin: Point', 'by: Point']
  )
  check('and the caret is in the second one', help.activeParameter, 1)

  /* --- 5. the buffer beats the file on disk ------------------------------- */

  console.log('\n--- an unsaved buffer ---')

  const EDITED = `import { translate } from './lib'

const other = translate({ x: 0, y: 0 }, { x: 1, y: 1 })
const spelled = other.
`
  const buffered = await ask(
    'completions',
    'src/app.ts',
    offsetOf(EDITED, 'other.') + 'other.'.length,
    { content: EDITED, version: 42 }
  )
  check(
    'answered against the buffer, not the file on disk',
    buffered.items.map((item) => item.label).sort(),
    ['x', 'y']
  )

  // And it persists, so the next query — carrying nothing — still sees it.
  const persisted = await ask('hover', 'src/app.ts', offsetOf(EDITED, 'other'))
  check('the overlay is what the daemon now holds', persisted.contents?.includes('other'), true)
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
