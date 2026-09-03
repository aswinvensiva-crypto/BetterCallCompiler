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
 * Go to definition ACROSS FILES, in TypeScript, from the daemon.
 *
 * This is the claim that justifies crossing a process boundary at all. Monaco's
 * bundled worker has no tsconfig, no file system and no module resolution, so
 * it cannot follow `./lib` — its go-to-definition never leaves the file you are
 * looking at, and `configureLanguageDefaults` switches its semantic validation
 * off for the same reason. The daemon has the real program.
 *
 * Two halves have to work for this to be visible, and both are new. The daemon
 * has to answer with a location in a file that is not open, and the renderer
 * has to be able to OPEN one: Monaco's standalone model service resolves a URI
 * only to a model that already exists, so without the editor opener registered
 * in `models.ts` the answer is correct and F12 appears to do nothing.
 *
 * The fixture is deliberately a real project — a tsconfig, a `src/`, a relative
 * import — because a flat directory with no config is the one case Monaco's
 * worker can already handle.
 *
 * Window pinned to 1024x730, and this spec owns its own files.
 */

const APP_ROOT = join(__dirname, '..', '..')
const MAIN_ENTRY = join(APP_ROOT, 'out', 'main', 'index.js')

const LIB = [
  'export interface Greeting {',
  '  readonly text: string',
  '}',
  '',
  'export function greet(name: string): Greeting {',
  '  return { text: `hello ${name}` }',
  '}',
  ''
].join('\n')

const APP = [
  "import { greet } from './lib'",
  '',
  "const shown = greet('world')",
  'console.log(shown.text)',
  ''
].join('\n')

const OTHER = [
  "import { greet } from './lib'",
  '',
  "export const pair = [greet('a'), greet('b')]",
  ''
].join('\n')

const TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      strict: true
    },
    include: ['src']
  },
  null,
  2
)

let fixture = ''
let app: ElectronApplication
let window: Page
const consoleProblems: string[] = []

const DAEMON_TIMEOUT = 30_000

test.beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'bcc-tsnav-'))
  await mkdir(join(fixture, 'src'), { recursive: true })
  await writeFile(join(fixture, 'tsconfig.json'), `${TSCONFIG}\n`)
  await writeFile(join(fixture, 'src', 'lib.ts'), LIB)
  await writeFile(join(fixture, 'src', 'app.ts'), APP)
  await writeFile(join(fixture, 'src', 'other.ts'), OTHER)

  app = await electron.launch({
    args: [MAIN_ENTRY, isolatedUserData('typescript-navigation'), `--folder=${fixture}`],
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

function row(name: string) {
  return window.locator('.tree__row', { has: window.locator(`.tree__label:text-is("${name}")`) })
}

const lines = () => window.locator('.monaco-editor .view-lines')
const activeLineNumber = () => window.locator('.monaco-editor .active-line-number')

/** See `bcc-navigation.spec.ts`: Monaco gives no node that means "this word". */
async function placeCaret(lineNumber: number, column: number): Promise<void> {
  await lines().click()
  await window.keyboard.press('Control+Home')
  for (let i = 1; i < lineNumber; i++) await window.keyboard.press('ArrowDown')
  for (let i = 1; i < column; i++) await window.keyboard.press('ArrowRight')
}

test('opens app.ts', async () => {
  await row('src').click()
  await row('app.ts').click()

  await expect(window.locator('.tab', { hasText: 'app.ts' })).toHaveCount(1)
  await expect(lines()).toContainText("const shown = greet('world')", {
    timeout: DAEMON_TIMEOUT
  })
})

/**
 * The whole justification, in one keystroke.
 *
 * `greet` on line 3 of `app.ts` is imported from `./lib`, which Monaco's worker
 * cannot resolve. A new tab for a file the user never opened is what says the
 * daemon answered and the editor opener carried it.
 */
test('F12 on an imported symbol opens the file it came from', async () => {
  // Column 15 is inside `greet` on `const shown = greet('world')`.
  await placeCaret(3, 16)
  await window.keyboard.press('F12')

  await expect(window.locator('.tab', { hasText: 'lib.ts' })).toHaveCount(1, {
    timeout: DAEMON_TIMEOUT
  })
  await expect(lines()).toContainText('export function greet(name: string): Greeting {')
  // Line 5 is the declaration — the jump lands ON it, not at the top of the file.
  await expect(activeLineNumber()).toHaveText('5', { timeout: DAEMON_TIMEOUT })
})

/**
 * Whole-program references, which is the other thing only the daemon can do.
 *
 * Six: the declaration, the import and call in `app.ts`, and the import and two
 * calls in `other.ts` — and `other.ts` has never been opened, so nothing in the
 * renderer has ever seen its text.
 */
test('Shift+F12 finds uses in files that were never opened', async () => {
  await expect(window.locator('.tab', { hasText: 'lib.ts' })).toHaveCount(1)
  await placeCaret(5, 18)
  await window.keyboard.press('Shift+F12')

  const peek = window.locator('.monaco-editor .peekview-widget')
  await expect(peek).toBeVisible({ timeout: DAEMON_TIMEOUT })

  // The tree groups by file and collapses all but the current one, so the count
  // comes from the header rather than from the visible rows — a row count would
  // be measuring which groups happen to be expanded.
  await expect(peek).toContainText('References (6)', { timeout: DAEMON_TIMEOUT })
  // `other.ts` has never been opened, so nothing in the renderer has ever seen
  // its text. Three: the import specifier and the two calls.
  await expect(peek.locator('.monaco-list-row', { hasText: 'other.ts' })).toHaveCount(1)
  await expect(peek).toContainText('app.ts')

  await window.keyboard.press('Escape')
  await expect(peek).toBeHidden()
})

test('nothing threw in the renderer', () => {
  expect(consoleProblems).toEqual([])
})
