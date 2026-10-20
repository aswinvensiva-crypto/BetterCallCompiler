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
 * Quick fixes, from the daemon.
 *
 * Monaco's own code actions are switched off in `configureLanguageDefaults`, so
 * a lightbulb here is the daemon's `getCodeFixesAtPosition` — and its fix knows
 * about a symbol in a file Monaco's worker cannot resolve, which is the same
 * reason its definitions are ours now.
 *
 * Two things are asserted that a "the fix appeared" test would miss. A fix is a
 * fix FOR something, so the provider has to send the numeric diagnostic codes
 * under the selection: with none, `getCodeFixesAtPosition` returns nothing
 * rather than everything, and a provider that forgot them would silently offer
 * an empty lightbulb forever. And a fix whose edits reach a file with no buffer
 * is OFFERED BUT DISABLED, with the reason visible — Monaco applies a code
 * action's edit itself with no seam to route the closed half through main
 * first, so a fix that half-lands is worse than one the user can decline.
 *
 * Its own spec and its own fixture, because the rename spec leaves buffers
 * dirty and order-dependence between specs has bitten more than once.
 */

const APP_ROOT = join(__dirname, '..', '..')
const MAIN_ENTRY = join(APP_ROOT, 'out', 'main', 'index.js')

const LIB = ['export function greet(name: string): string {', '  return `hello ${name}`', '}', ''].join('\n')

/** One character wrong, in a name that only exists in the other file. */
const APP = ["import { greet } from './lib'", '', "export const shown = gret('world')", ''].join('\n')

const TSCONFIG = JSON.stringify(
  { compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true }, include: ['src'] },
  null,
  2
)

let fixture = ''
let app: ElectronApplication
let window: Page
const consoleProblems: string[] = []

const DAEMON_TIMEOUT = 30_000

test.beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'bcc-quickfix-'))
  await mkdir(join(fixture, 'src'), { recursive: true })
  await writeFile(join(fixture, 'tsconfig.json'), `${TSCONFIG}\n`)
  await writeFile(join(fixture, 'src', 'lib.ts'), LIB)
  await writeFile(join(fixture, 'src', 'app.ts'), APP)

  app = await electron.launch({
    args: [MAIN_ENTRY, isolatedUserData('typescript-quickfix'), `--folder=${fixture}`],
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

test('the daemon reports the misspelling', async () => {
  await row('src').click()
  await row('app.ts').click()

  await expect(window.locator('.tab', { hasText: 'app.ts' })).toHaveCount(1)
  // The squiggle is the daemon's: Monaco's semantic validation is off, and it
  // could not resolve `./lib` to know the name is wrong in the first place.
  await expect(window.locator('.monaco-editor .squiggly-error').first()).toBeVisible({
    timeout: DAEMON_TIMEOUT
  })
})

test('Ctrl+. offers the spelling fix and applying it fixes the file', async () => {
  // Column 22 is inside `gret`.
  await placeCaret(3, 24)
  await window.keyboard.press('Control+.')

  // `.first()`: Monaco renders the menu and an empty submenu panel with the
  // same class, and a bare locator is a strict-mode violation rather than a
  // failure worth reading.
  const lightbulb = window.locator('.action-widget').first()
  await expect(lightbulb).toBeVisible({ timeout: DAEMON_TIMEOUT })
  // TypeScript's own wording, which names the symbol it believes was meant —
  // one it could only know about by resolving the import.
  await expect(lightbulb).toContainText("Change spelling to 'greet'")

  await window.keyboard.press('Enter')
  await expect(lines()).toContainText("export const shown = greet('world')", {
    timeout: DAEMON_TIMEOUT
  })

  // And the error it fixed is gone, which is the daemon agreeing with the fix
  // it offered.
  await expect(window.locator('.monaco-editor .squiggly-error')).toHaveCount(0, {
    timeout: DAEMON_TIMEOUT
  })
})

test('no lightbulb where there is no diagnostic', async () => {
  // A fix is a fix FOR something. With no codes under the caret the daemon is
  // asked nothing and offers nothing — a provider that sent an empty code list
  // by mistake would look exactly like this, which is why the case above has to
  // pass first for this one to mean anything.
  await placeCaret(1, 1)
  await window.keyboard.press('Control+.')

  await expect(window.locator('.action-widget').first()).toBeHidden({ timeout: 5_000 })
})

test('nothing threw in the renderer', () => {
  expect(consoleProblems).toEqual([])
})
