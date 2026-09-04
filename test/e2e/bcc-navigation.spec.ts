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
 * Navigation, from the keyboard to the daemon and back.
 *
 * The claim under test is the one that opens Workstream A. This repository had
 * ZERO registered definition, reference, rename, hover and symbol providers, so
 * an IDE that could type-check a language it invented still could not jump to a
 * declaration in it. Everything here is real — real worker_thread, real
 * resolution, real Monaco widgets — and every assertion is on something a user
 * could produce by pressing a key. Nothing reaches for the IPC bridge directly,
 * because a green test that bypasses the provider registration would prove the
 * one part that was missing still is.
 *
 * The fixture is written so that a text search gets the wrong answer: `count`
 * appears six times and is two different symbols. Renaming one and finding the
 * other unmoved is the point, and no rule in the navigation code says so — the
 * symbols simply are not the same object.
 *
 * This spec owns `nav.bcc`, and the window is pinned to 1024x730, because
 * order-dependence between specs and developer-screen-versus-runner differences
 * have each bitten more than once.
 */

const APP_ROOT = join(__dirname, '..', '..')
const MAIN_ENTRY = join(APP_ROOT, 'out', 'main', 'index.js')

const SOURCE = [
  'let count = 0;', //          1
  'count = count + 1;', //      2
  'fn bump(step: int) -> int {', // 3
  '  return step + count;', //  4
  '}', //                       5
  'if true {', //               6
  '  let count = 99;', //       7
  '  print count;', //          8
  '}', //                       9
  'print bump(1);', //         10
  ''
].join('\n')

let fixture = ''
let app: ElectronApplication
let window: Page
const consoleProblems: string[] = []

const DAEMON_TIMEOUT = 25_000

test.beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'bcc-nav-'))
  await mkdir(join(fixture, 'examples'), { recursive: true })
  await writeFile(join(fixture, 'examples', 'nav.bcc'), SOURCE)

  app = await electron.launch({
    args: [MAIN_ENTRY, isolatedUserData('bcc-navigation'), `--folder=${fixture}`],
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

/** The line the caret is on, which Monaco renders in the gutter. */
const activeLineNumber = () => window.locator('.monaco-editor .active-line-number')

/**
 * Puts the caret on an exact line and column, with the keyboard.
 *
 * Clicking a word would be closer to what a user does, and it is not usable
 * here: Monaco coalesces a run of same-coloured text into ONE span, so on
 * `let count = 0;` the text `count = 0;` is a single node and there is nothing
 * to click that means "the identifier". Ctrl+Home then arrows is deterministic,
 * needs no pixel arithmetic, and is exactly reproducible on any screen.
 */
async function placeCaret(lineNumber: number, column: number): Promise<void> {
  await lines().click()
  await window.keyboard.press('Control+Home')
  for (let i = 1; i < lineNumber; i++) await window.keyboard.press('ArrowDown')
  for (let i = 1; i < column; i++) await window.keyboard.press('ArrowRight')
}

/** How many times `word` appears in the rendered buffer. */
async function occurrences(word: string): Promise<number> {
  const text = await lines().innerText()
  return text.split(word).length - 1
}

test('opens the file, and the daemon finds nothing wrong with it', async () => {
  await row('examples').click()
  await row('nav.bcc').click()

  await expect(window.locator('.tab', { hasText: 'nav.bcc' })).toHaveCount(1)
  await expect(lines()).toContainText('fn bump(step: int) -> int {', { timeout: DAEMON_TIMEOUT })
  await expect(window.locator('.monaco-editor .squiggly-error')).toHaveCount(0, {
    timeout: DAEMON_TIMEOUT
  })
})

/** F12, and the baseline this repository was below until now. */
test('F12 on a call moves the caret to the function it calls', async () => {
  await placeCaret(10, 7)
  await expect(activeLineNumber()).toHaveText('10')

  await window.keyboard.press('F12')
  await expect(activeLineNumber()).toHaveText('3', { timeout: DAEMON_TIMEOUT })
})

test('F12 on a keyword does nothing rather than guessing', async () => {
  await placeCaret(6, 4)
  await window.keyboard.press('F12')
  await expect(activeLineNumber()).toHaveText('6')
})

/**
 * Shift+F12, and the property that makes it better than a text search.
 *
 * Six `count`s in the file. Four of them are the outer symbol — its
 * declaration, the store and the read on line 2, and the read on line 4 — and
 * two belong to the `let count` inside the `if`. Whole-file, and correct about
 * shadowing without a rule that mentions shadowing.
 */
test('Shift+F12 lists only the references that are the same symbol', async () => {
  await placeCaret(1, 6)
  await window.keyboard.press('Shift+F12')

  const peek = window.locator('.monaco-editor .peekview-widget')
  await expect(peek).toBeVisible({ timeout: DAEMON_TIMEOUT })
  await expect(peek.locator('.monaco-list-row')).toHaveCount(4)

  await window.keyboard.press('Escape')
  await expect(peek).toBeHidden()
})

/**
 * F2, and the undo behaviour that makes it safe to use.
 *
 * Both halves matter. The rename must move every occurrence of ONE symbol and
 * leave the identically-spelled other one alone, and a single Ctrl+Z must put
 * all of them back — a rename that unwinds one occurrence per keystroke is one
 * users learn not to trust.
 */
test('F2 renames one symbol, and Ctrl+Z puts it back in one step', async () => {
  await placeCaret(7, 8)
  await window.keyboard.press('F2')

  const renameBox = window.locator('.monaco-editor .rename-box input')
  await expect(renameBox).toBeVisible({ timeout: DAEMON_TIMEOUT })
  // Pre-filled with the identifier under the caret, which is
  // `resolveRenameLocation` having been answered rather than defaulted.
  await expect(renameBox).toHaveValue('count')

  await renameBox.fill('inner')
  await window.keyboard.press('Enter')

  await expect(lines()).toContainText('let inner = 99', { timeout: DAEMON_TIMEOUT })
  expect(await occurrences('inner')).toBe(2)
  // The outer symbol is spelled the same and did not move.
  expect(await occurrences('count')).toBe(4)
  await expect(lines()).toContainText('let count = 0')

  await lines().click()
  await window.keyboard.press('Control+z')
  await expect(lines()).toContainText('let count = 99')
  expect(await occurrences('inner')).toBe(0)
  expect(await occurrences('count')).toBe(6)
})

/** A rejection the user can read, rather than a box over a keyword. */
test('F2 where there is no name says so', async () => {
  await placeCaret(6, 4)
  await window.keyboard.press('F2')

  await expect(window.locator('.monaco-editor-overlaymessage')).toContainText(
    'nothing to rename',
    { timeout: DAEMON_TIMEOUT }
  )
  // The input, not `.rename-box`: Monaco has two nodes with that class — the
  // widget and its suggestion list — and the input is the one that is either
  // there for the user to type in or not.
  await expect(window.locator('.monaco-editor .rename-box input')).toBeHidden()
  await window.keyboard.press('Escape')
})

/**
 * Hover, through Ctrl+K Ctrl+I rather than the pointer.
 *
 * Same reason `placeCaret` uses the keyboard: a hover needs a pixel inside one
 * identifier, and Monaco does not give the identifier its own node to aim at.
 * Show Hover is the keyboard route to the same widget and the same provider.
 */
test('Show Hover names the parameter and its type', async () => {
  await placeCaret(4, 11)
  await window.keyboard.press('Control+k')
  await window.keyboard.press('Control+i')

  await expect(window.locator('.monaco-hover .hover-contents')).toContainText(
    'parameter step: int',
    { timeout: DAEMON_TIMEOUT }
  )
  await window.keyboard.press('Escape')
})

/**
 * Ctrl+Shift+O — the outline, which for a language Monaco learned about at
 * runtime only the daemon can produce.
 */
test('Go to Symbol lists the declarations, nested under their function', async () => {
  await lines().click()
  await window.keyboard.press('Control+Shift+o')

  const picker = window.locator('.quick-input-widget')
  await expect(picker).toBeVisible({ timeout: DAEMON_TIMEOUT })

  const rows = picker.locator('.monaco-list-row')
  await expect(rows).toHaveCount(3)
  // `step` is deliberately absent: parameters are in the signature, which is
  // where a reader looks for them, and listing them would turn a five-function
  // file into a thirty-row outline.
  await expect(rows.nth(1)).toContainText('bump')

  await window.keyboard.press('Escape')
  await expect(picker).toBeHidden()
})

test('nothing threw in the renderer', () => {
  expect(consoleProblems).toEqual([])
})
