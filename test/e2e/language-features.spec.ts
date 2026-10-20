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
 * The half of the language surface Monaco's own worker owns, pinned.
 *
 * These features are not new — Monaco's TypeScript contribution registers an
 * outline and a formatter from inside node_modules the first time a `.ts` model
 * appears, which is why the audit's grep over `src/` found no
 * `registerDocumentSymbolProvider` and was still looking at a working outline.
 * What was new is that NOTHING asserted them. `configureLanguageDefaults` now
 * states the whole split explicitly, and a mode configuration is one word away
 * from silently removing a feature nobody would notice was gone until they
 * reached for it.
 *
 * So this spec is a regression pin rather than a new capability, and it is
 * deliberately about the two features that stay in the renderer for good: an
 * outline and a formatter are single-file and syntactic, so the tsconfig
 * Monaco's worker lacks is irrelevant to both, and they answer instantly and
 * are never queued behind a check.
 *
 * The fixture has NO local imports, on purpose. Monaco's worker cannot resolve
 * them and this spec is not about what it gets wrong — that is A3's subject.
 *
 * Window pinned to 1024x730, and this spec owns `shape.ts`.
 */

const APP_ROOT = join(__dirname, '..', '..')
const MAIN_ENTRY = join(APP_ROOT, 'out', 'main', 'index.js')

/** Deliberately misformatted, in ways `tsserver`'s formatter is opinionated about. */
const UNFORMATTED = [
  'export interface Point { x: number; y: number }',
  'export function add(a:number,b:number):number{',
  '  return a+b',
  '}',
  'export const origin: Point = { x: 0, y: 0 }',
  ''
].join('\n')

let fixture = ''
let app: ElectronApplication
let window: Page
const consoleProblems: string[] = []

const READY_TIMEOUT = 25_000

test.beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'bcc-langfeat-'))
  await mkdir(join(fixture, 'src'), { recursive: true })
  await writeFile(join(fixture, 'src', 'shape.ts'), UNFORMATTED)
  await writeFile(join(fixture, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}\n')

  app = await electron.launch({
    args: [MAIN_ENTRY, isolatedUserData('language-features'), `--folder=${fixture}`],
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

test('opens a TypeScript file', async () => {
  await row('src').click()
  await row('shape.ts').click()

  await expect(window.locator('.tab', { hasText: 'shape.ts' })).toHaveCount(1)
  await expect(lines()).toContainText('export function add', { timeout: READY_TIMEOUT })
})

test('Go to Symbol lists the file structure', async () => {
  await lines().click()
  await window.keyboard.press('Control+Shift+o')

  const picker = window.locator('.quick-input-widget')
  await expect(picker).toBeVisible({ timeout: READY_TIMEOUT })
  // Seven: the interface, its two members, the function, the const and its two
  // members. Members carry their container's name in the row's description, so
  // filtering on `origin` matches three rows — the count is the honest
  // assertion and a change to it is exactly what this pin exists to catch.
  const rows = picker.locator('.monaco-list-row')
  await expect(rows).toHaveCount(7)
  await expect(rows.filter({ hasText: 'add' })).toHaveCount(1)

  await window.keyboard.press('Escape')
  await expect(picker).toBeHidden()
})

/**
 * Two assertions, because the interesting failure is not the same as the
 * obvious one.
 *
 * The menu item being OFFERED is what proves the provider is registered:
 * Monaco gates Format Document on `editorHasDocumentFormattingProvider`, so
 * with `documentRangeFormattingEdits` switched off the entry would simply not
 * be there. Running it proves the worker answered.
 *
 * The keystroke differs by platform and that is Monaco's doing, not ours —
 * Shift+Alt+F everywhere except Linux, where it is Ctrl+Shift+I. A spec written
 * against one of them passes on the CI runner and quietly does nothing on a
 * developer machine, so it is chosen here rather than assumed.
 */
const FORMAT_DOCUMENT = process.platform === 'linux' ? 'Control+Shift+i' : 'Shift+Alt+f'

test('Format Document is offered, and rewrites the file', async () => {
  await expect(lines()).toContainText('add(a:number,b:number)')

  await lines().click({ button: 'right' })
  const menu = window.locator('.monaco-menu')
  await expect(menu).toBeVisible()
  const item = menu.locator('.action-item', { hasText: 'Format Document' })
  await expect(item).toHaveCount(1)
  await expect(item).not.toHaveClass(/disabled/)
  await window.keyboard.press('Escape')
  await expect(menu).toBeHidden()

  await lines().click()
  await window.keyboard.press(FORMAT_DOCUMENT)

  await expect(lines()).toContainText('add(a: number, b: number): number {', {
    timeout: READY_TIMEOUT
  })
  await expect(lines()).toContainText('return a + b')
  // The tab is dirty, because a format is an edit like any other and the file
  // on disk has not been touched.
  await expect(window.locator('.tab__close--dirty')).toHaveCount(1)
})

/**
 * The rule the split is built on, asserted from the outside.
 *
 * Monaco's worker has no tsconfig and no file system, so its semantic
 * validation reports a false `TS2307` for every local import. It is turned off
 * in `configureLanguageDefaults`, and the daemon — which has the real program —
 * publishes instead. This checks that the SYNTACTIC half survived that: a
 * missing brace is model-local and must still be underlined.
 */
test('a syntax error is still underlined by Monaco itself', async () => {
  await lines().click()
  await window.keyboard.press('Control+End')
  await window.keyboard.type('\nfunction broken( {\n')

  await expect(window.locator('.monaco-editor .squiggly-error').first()).toBeVisible({
    timeout: READY_TIMEOUT
  })
})

test('nothing threw in the renderer', () => {
  expect(consoleProblems).toEqual([])
})
