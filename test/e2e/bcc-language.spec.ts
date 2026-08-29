import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isolatedUserData } from './helpers/user-data'

/**
 * BCC, end to end.
 *
 * The claim under test is the milestone: a file in a language that did not
 * exist a week ago gets a red squiggle and a Problems row, in an IDE that was
 * never told about it. Nothing here is stubbed — real chokidar, real
 * worker_thread, real lexer and parser, real Monaco markers.
 *
 * What makes it interesting is what did NOT change to make it work. The
 * Problems panel, `marker-mapping.ts`, the status bar counts and the
 * clean-sweep semantics are the same code that serves TypeScript. The whole
 * integration is `toDiagnosticMessages` plus a routing decision on the file
 * extension.
 *
 * The window is pinned to 1024x730 because three failures this session came
 * from specs behaving differently on a developer screen than on the runner.
 */

const APP_ROOT = join(__dirname, '..', '..')
const MAIN_ENTRY = join(APP_ROOT, 'out', 'main', 'index.js')

const CLEAN = 'fn add(a: int, b: int) -> int {\n  return a + b;\n}\n'
/** One missing semicolon. The most common real mistake, and a zero-width span. */
const BROKEN = 'fn add(a: int, b: int) -> int {\n  return a + b\n}\n'

let fixture = ''
let app: ElectronApplication
let window: Page
const consoleProblems: string[] = []

const DAEMON_TIMEOUT = 25_000

test.beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'bcc-lang-'))
  await mkdir(join(fixture, 'examples'), { recursive: true })
  await writeFile(join(fixture, 'examples', 'add.bcc'), CLEAN)

  app = await electron.launch({
    args: [MAIN_ENTRY, isolatedUserData('bcc-language'), `--folder=${fixture}`],
    cwd: APP_ROOT
  })
  window = await app.firstWindow()

  window.on('console', (message) => {
    if (message.type() === 'error') consoleProblems.push(message.text())
  })
  window.on('pageerror', (error) => consoleProblems.push(error.message))

  await window.waitForSelector('html[data-bettercallcompiler-ready="true"]')
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win?.setBounds({ x: 0, y: 0, width: 1024, height: 730 })
  })
})

test.afterAll(async () => {
  await app?.close()
  if (fixture !== '') await rm(fixture, { recursive: true, force: true })
})

async function openProblems(): Promise<void> {
  await window.locator('.activity-bar__item[data-view-id="problems"]').click()
  await expect(window.locator('#panel-problems-view')).toBeVisible()
}

const problemGroups = () => window.locator('.problems-group__path')

test('a clean .bcc file reports nothing', async () => {
  await openProblems()
  await expect(problemGroups().filter({ hasText: '.bcc' })).toHaveCount(0, {
    timeout: DAEMON_TIMEOUT
  })
})

/**
 * The milestone. The file is never opened — only written to disk — and the
 * daemon that finds the error is one this IDE grew for a language it invented.
 */
test('a syntax error in a .bcc file appears in the Problems panel', async () => {
  await openProblems()
  await writeFile(join(fixture, 'examples', 'add.bcc'), BROKEN)

  await expect(problemGroups()).toHaveText(['examples/add.bcc'], { timeout: DAEMON_TIMEOUT })
  // The code is BCC's own, carried end to end from `src/lang/diagnostic.ts`
  // through the worker, the store and the IPC boundary without translation.
  await expect(window.locator('.problems-row__code')).toHaveText(['BCC0003'])
  await expect(window.locator('.problems-summary')).toContainText('1 error')
})

test('clicking the row opens the file and the editor draws a squiggle', async () => {
  await openProblems()
  await window.locator('.problems-row').first().click()

  await expect(window.locator('.tab', { hasText: 'add.bcc' })).toHaveCount(1)
  await expect(window.locator('.monaco-editor .view-lines')).toContainText('return a + b')

  // The diagnostic is reported at a POSITION, not over a range — a missing
  // token has no width. Monaco draws nothing for a zero-width marker, so this
  // being visible is what proves `clampRange` widened it.
  await expect(window.locator('.monaco-editor .squiggly-error').first()).toBeVisible({
    timeout: DAEMON_TIMEOUT
  })
})

test('the file is syntax-highlighted as bcc, not as plain text', async () => {
  // Registered from `KEYWORDS` in src/lang/token.ts, so the highlighter cannot
  // drift from the lexer's idea of what a keyword is.
  //
  // Asserted through the rendered tokens rather than by asking Monaco for the
  // model's language id: Monaco is loaded lazily and is not on `globalThis`, so
  // that question can only be answered from inside the app. What a user can see
  // is that the line is broken into more than one colour class — `fn` styled as
  // a keyword and `add` as an identifier. An unregistered language renders the
  // whole line as a single `mtk` class, so one distinct class means plain text
  // and more than one means the tokenizer ran.
  await expect(window.locator('.monaco-editor .view-line').first()).toBeVisible({
    timeout: DAEMON_TIMEOUT
  })

  // Read through Playwright's own API rather than `evaluate`. The E2E specs are
  // compiled by the node tsconfig project, which has no DOM lib — touching
  // `document` here is a TS2584 even though the callback would run in the
  // browser. Same reason `cold-start.spec.ts` reaches for `globalThis`.
  const spans = window.locator('.monaco-editor .view-line').first().locator('span')
  const count = await spans.count()
  const classes = await Promise.all(
    Array.from({ length: count }, (_, index) => spans.nth(index).getAttribute('class'))
  )

  expect(new Set(classes).size).toBeGreaterThan(1)
})

/**
 * The half everyone forgets. An empty diagnostics array is the "now clean"
 * signal; treated as an empty batch and skipped, the squiggle and the row
 * survive the fix forever.
 */
test('fixing the error clears both the row and the squiggle', async () => {
  await writeFile(join(fixture, 'examples', 'add.bcc'), CLEAN)

  await openProblems()
  await expect(problemGroups()).toHaveCount(0, { timeout: DAEMON_TIMEOUT })
  await expect(window.locator('.monaco-editor .squiggly-error')).toHaveCount(0, {
    timeout: DAEMON_TIMEOUT
  })
})

/**
 * Editing the buffer without saving must report against what the user can see.
 * This also exercises the IPC routing: `compiler:openDocument` is one channel
 * that reaches two different daemons depending on the extension.
 */
test('an unsaved edit is checked from the buffer, not from disk', async () => {
  // Established rather than assumed. An earlier failure here timed out on a
  // bare `.monaco-editor` click with nothing to say about why; asserting the
  // tab first turns "the editor was not there" into a specific failure instead
  // of a thirty-second mystery.
  await expect(window.locator('.tab', { hasText: 'add.bcc' })).toHaveCount(1)
  await window.locator('.tab', { hasText: 'add.bcc' }).click()

  await window.locator('.monaco-editor .view-lines').click()
  await window.keyboard.press('Control+End')
  await window.keyboard.type('\nlet broken = ;\n')

  await openProblems()
  await expect(window.locator('.problems-row__code', { hasText: 'BCC0004' }).first()).toBeVisible({
    timeout: DAEMON_TIMEOUT
  })
})

/**
 * The type checker, end to end.
 *
 * It went in behind the same query pipeline and the same `FileDiagnostics`
 * shape, so nothing between the worker and the squiggle knows it exists. This
 * is the assertion that says so: a type error is not a different kind of thing
 * to the editor, it is another diagnostic with another code.
 */
/**
 * Scoped to one file's group rather than to the whole panel.
 *
 * The test above leaves an UNSAVED buffer on add.bcc, and the daemon correctly
 * prefers a buffer to what is on disk — so writing to that file here would
 * change nothing, and asserting on the panel's whole contents would depend on
 * which tests ran first. Each of the two below owns a file nothing else touches.
 */
const rowsFor = (relativePath: string) =>
  window.locator('.problems-group').filter({ hasText: relativePath })

test('a type error reaches the editor too, with its own code', async () => {
  await writeFile(
    join(fixture, 'examples', 'typed.bcc'),
    'fn add(a: int, b: int) -> int {\n  return a + true;\n}\n'
  )

  await openProblems()
  const group = rowsFor('examples/typed.bcc')
  await expect(group.locator('.problems-row__code')).toHaveText(['BCC0013'], {
    timeout: DAEMON_TIMEOUT
  })
  await expect(group.locator('.problems-row__message')).toContainText('needs int operands')
  // The operator, not the whole expression: `+` is what is wrong.
  await expect(group.locator('.problems-row__position')).toHaveText('2:12')
})

test('a name the program never declares is reported where it is used', async () => {
  await writeFile(join(fixture, 'examples', 'named.bcc'), 'print nope;\n')

  await openProblems()
  const group = rowsFor('examples/named.bcc')
  await expect(group.locator('.problems-row__code')).toHaveText(['BCC0008'], {
    timeout: DAEMON_TIMEOUT
  })
  // Column 7, under `nope` itself rather than at the start of the line.
  await expect(group.locator('.problems-row__position')).toHaveText('1:7')
})

test('nothing threw in the renderer', () => {
  expect(consoleProblems).toEqual([])
})
