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
 * Hover, completions and signature help, from the third worker.
 *
 * The claim is the same one that justified the second: Monaco's bundled worker
 * has no tsconfig and no module resolution, so what it can say about a symbol
 * imported from another file is a guess. What is new is that these three are
 * asked at KEYSTROKE frequency, which is why they cannot come from the check
 * worker — reaching it means cancelling its check, and a check cancelled on
 * every character never converges.
 *
 * The fixture is built so a file-local answer is visibly wrong rather than
 * merely incomplete: `moved` has no annotation and its type is the return type
 * of a function in another file, so completing `moved.` at all requires having
 * resolved `./lib`. Monaco's worker types it `any` and offers nothing.
 *
 * Window pinned to 1024x730, and this spec owns its own files.
 */

const APP_ROOT = join(__dirname, '..', '..')
const MAIN_ENTRY = join(APP_ROOT, 'out', 'main', 'index.js')

const LIB = [
  'export interface Point {',
  '  readonly across: number',
  '  readonly down: number',
  '}',
  '',
  '/** Adds two points together. */',
  'export function translate(origin: Point, by: Point): Point {',
  '  return { across: origin.across + by.across, down: origin.down + by.down }',
  '}',
  ''
].join('\n')

const APP = [
  "import { translate } from './lib'",
  '',
  'const start = { across: 1, down: 2 }',
  'const moved = translate(start, { across: 3, down: 4 })',
  'export const shown = moved',
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
  fixture = await mkdtemp(join(tmpdir(), 'bcc-interactive-'))
  await mkdir(join(fixture, 'src'), { recursive: true })
  await writeFile(join(fixture, 'tsconfig.json'), `${TSCONFIG}\n`)
  await writeFile(join(fixture, 'src', 'lib.ts'), LIB)
  await writeFile(join(fixture, 'src', 'app.ts'), APP)

  app = await electron.launch({
    args: [MAIN_ENTRY, isolatedUserData('typescript-interactive'), `--folder=${fixture}`],
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
  await expect(lines()).toContainText('const moved = translate', { timeout: DAEMON_TIMEOUT })
})

/**
 * ONE hover, and it is the daemon's.
 *
 * The count is the assertion, not decoration. Monaco's TypeScript contribution
 * reads its mode configuration when the first `.ts` model appears and never
 * listens for a change, so a handover deferred until the daemon reported ready
 * was a silent no-op — and the editor showed `const moved: Point` from ours and
 * `const moved: any` from Monaco's, stacked in one tooltip. Two hover contents
 * here means the decision moved back to somewhere too late to matter.
 *
 * `moved` has no annotation. Its type is the return type of a function in
 * another file, so saying `Point` at all requires having resolved `./lib` —
 * which is exactly what Monaco's worker cannot do, and why its answer was
 * `any`.
 */
test('hover names a type inferred from another file, once', async () => {
  await placeCaret(5, 22)
  await window.keyboard.press('Control+k')
  await window.keyboard.press('Control+i')

  const contents = window.locator('.monaco-hover .hover-contents')
  await expect(contents).toHaveCount(1, { timeout: DAEMON_TIMEOUT })
  await expect(contents).toContainText('const moved: Point')

  await window.keyboard.press('Escape')
})

/**
 * The claim, in the place it is most visible.
 *
 * `moved` has no annotation; its type is the return type of a function in
 * another file. Monaco's worker cannot resolve `./lib`, types it `any`, and
 * offers nothing after the dot. These member names exist in exactly one place
 * in the workspace and are deliberately not English words that could arrive
 * from a word-based suggestion.
 */
test('completing a member of a type declared in another file', async () => {
  await placeCaret(5, 27)
  await window.keyboard.type('.')

  const suggest = window.locator('.suggest-widget')
  await expect(suggest).toBeVisible({ timeout: DAEMON_TIMEOUT })
  await expect(suggest).toContainText('across')
  await expect(suggest).toContainText('down')

  // Accepting writes it, which is the round trip closing.
  await window.keyboard.type('acr')
  await window.keyboard.press('Tab')
  await expect(lines()).toContainText('moved.across')
})

/** Signature help, which needs the parameter names from the other file too. */
test('signature help names the parameters of an imported function', async () => {
  await placeCaret(6, 1)
  await window.keyboard.type('translate(')

  const parameterHints = window.locator('.parameter-hints-widget')
  await expect(parameterHints).toBeVisible({ timeout: DAEMON_TIMEOUT })
  await expect(parameterHints).toContainText('origin: Point')
  await expect(parameterHints).toContainText('by: Point')

  await window.keyboard.press('Escape')
})

test('nothing threw in the renderer', () => {
  expect(consoleProblems).toEqual([])
})
