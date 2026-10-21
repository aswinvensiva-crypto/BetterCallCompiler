import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isolatedUserData } from './helpers/user-data'

const APP_ROOT = join(__dirname, '..', '..')
const MAIN_ENTRY = join(APP_ROOT, 'out', 'main', 'index.js')

const VALID = 'let total: int = 0;\nprint total;\n'
const MISSING_SEMICOLON = 'fn add(a: int, b: int) -> int {\n  return a + b\n}\n'
// Long enough to overflow the source pane at any dock height.
const LONG = Array.from({ length: 80 }, (_, i) => `let v${i + 1}: int = ${i + 1};`).join('\n') + '\n'

let fixture = ''
let app: ElectronApplication
let window: Page
const consoleProblems: string[] = []

test.beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'substrate-e2e-'))
  await mkdir(join(fixture, 'examples'), { recursive: true })
  await writeFile(join(fixture, 'examples', 'valid.bcc'), VALID)
  await writeFile(join(fixture, 'examples', 'broken.bcc'), MISSING_SEMICOLON)
  await writeFile(join(fixture, 'examples', 'long.bcc'), LONG)

  app = await electron.launch({
    args: [MAIN_ENTRY, isolatedUserData('substrate'), `--folder=${fixture}`],
    cwd: APP_ROOT
  })
  window = await app.firstWindow()

  window.on('console', (message) => {
    if (message.type() === 'error') consoleProblems.push(message.text())
  })
  window.on('pageerror', (error) => consoleProblems.push(error.message))

  await window.waitForSelector('html[data-bettercallcompiler-ready="true"]')
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1440, height: 900 })
  })
})

// Every test drives the one app launched above, and the console check reads
// what all of them logged.
test.describe.configure({ mode: 'serial' })

test.afterAll(async () => {
  await app?.close()
  if (fixture !== '') await rm(fixture, { recursive: true, force: true })
})

function row(name: string) {
  return window.locator('.tree__row', { has: window.locator(`.tree__label:text-is("${name}")`) })
}

async function openFile(name: string): Promise<void> {
  await window.locator('.activity-bar__item[data-view-id="explorer"]').click()
  if ((await row(name).count()) === 0) await row('examples').click()
  await row(name).click()
  await window.locator('.monaco-editor .view-lines').first().waitFor()
}

async function openSubstrate(): Promise<void> {
  const verdict = window.locator('.substrate__verdict')
  // The activity item toggles the dock, so a second click would close it.
  if (!(await verdict.isVisible())) {
    await window.locator('.activity-bar__item[data-view-id="substrate"]').click()
  }
  await expect(verdict).toBeVisible()
}

function stage(id: string) {
  return window.locator(`.substrate__stage[data-stage-id="${id}"]`)
}

/** The selected stage's projection. */
function projection() {
  return window.locator('.substrate__pane')
}

function traced() {
  return window.locator('.substrate__trace-what')
}

/** The editor's own line numbers that Substrate has marked as traced. */
function beamLines() {
  return window.locator('.monaco-editor .line-numbers.substrate-beam-line')
}

/** Puts the editor's caret at the start of line `line`, through the keyboard. */
async function caretToLine(line: number): Promise<void> {
  await window.locator('.monaco-editor .view-lines').first().click()
  await window.keyboard.press('Control+Home')
  for (let i = 1; i < line; i++) await window.keyboard.press('ArrowDown')
  await window.keyboard.press('Home')
}

/** How far down the projection is scrolled; with `toEnd`, scrolls it to the bottom first. */
function projectionScroll(toEnd = false): Promise<number> {
  return window.evaluate((end) => {
    type Scroller = { scrollTop: number; scrollHeight: number }
    const doc = (globalThis as unknown as { document: { querySelector(s: string): Scroller | null } }).document
    const pane = doc.querySelector('[data-scroll-key^="projection:"]')
    if (pane === null) return -1
    if (end) pane.scrollTop = pane.scrollHeight
    return pane.scrollTop
  }, toEnd)
}

test('a valid program is verified, with every front-end stage passing', async () => {
  await openFile('valid.bcc')
  await openSubstrate()

  await expect(window.locator('.substrate__verdict')).toHaveAttribute('data-state', 'pass')
  for (const id of ['tokens', 'ast', 'symbols', 'types']) {
    await expect(stage(id)).toHaveAttribute('data-state', 'ok')
  }
})

test('a missing semicolon halts at AST, and Types reads not reached rather than clean', async () => {
  await openFile('broken.bcc')
  await openSubstrate()

  await expect(window.locator('.substrate__verdict')).toHaveAttribute('data-state', 'fail')
  // The halting stage, not a fixed one: this used to read 04 for every error.
  await expect(window.locator('.substrate__verdict')).toContainText('halted at 02')
  await expect(stage('tokens')).toHaveAttribute('data-state', 'ok')
  await expect(stage('ast')).toHaveAttribute('data-state', 'error')
  await expect(stage('ast')).toContainText('1 err')
  await expect(stage('types')).toHaveAttribute('data-state', 'blocked')
  await expect(stage('types')).toContainText('not reached')
})

test('the syntax error is listed under AST, never under Types', async () => {
  await openFile('broken.bcc')
  await openSubstrate()

  await stage('types').click()
  await expect(projection()).toContainText('Types')
  await expect(projection()).not.toContainText('BCC0003')

  await stage('ast').click()
  await expect(projection()).toContainText('BCC0003')
  await expect(projection()).toContainText("expected ';'")
})

test('the caret in the editor is what gets traced, and the trace is marked there', async () => {
  await openFile('valid.bcc')
  await openSubstrate()

  await caretToLine(2)
  await expect(traced()).toContainText('Print')
  await expect(window.locator('.monaco-editor .substrate-beam').first()).toBeVisible()
  await expect(beamLines()).toHaveText(['2'])
})

test('clicking a stage row moves the editor caret to the construct it came from', async () => {
  await openFile('valid.bcc')
  await openSubstrate()
  await caretToLine(1)
  await expect(beamLines()).toHaveText(['1'])

  await stage('tokens').click()
  // `print` is the sixth significant token: let total : int = 0 ; print …
  await projection().locator('.substrate__row', { hasText: 'print' }).click()
  await expect(traced()).toContainText('Print')
  await expect(beamLines()).toHaveText(['2'])
})

test('a click far down the projection keeps the projection where it was', async () => {
  await openFile('long.bcc')
  await openSubstrate()
  await stage('tokens').click()

  expect(await projectionScroll(true)).toBeGreaterThan(0)

  // The click moves the caret, which re-renders the whole view; the reader
  // must not land back on the first row.
  await projection().locator('.substrate__row').last().click()
  await expect(beamLines()).toHaveCount(0)
  expect(await projectionScroll()).toBeGreaterThan(0)
})

test('switching files traces each file from its own caret', async () => {
  await openFile('valid.bcc')
  await openSubstrate()
  await caretToLine(2)
  await expect(traced()).toContainText('Print')

  await openFile('long.bcc')
  await caretToLine(80)
  await expect(traced()).toContainText('Let v80')

  // v80's offset sits far past the end of valid.bcc and would select nothing
  // there. Back in valid.bcc the trace is its own caret, which the editor kept.
  await openFile('valid.bcc')
  await expect(traced()).toContainText('Print')
  await expect(beamLines()).toHaveText(['2'])
})

test('closing the dock takes the marks out of the editor', async () => {
  await openFile('valid.bcc')
  await openSubstrate()
  await caretToLine(2)
  await expect(beamLines()).toHaveText(['2'])

  await window.locator('.activity-bar__item[data-view-id="substrate"]').click()
  await expect(window.locator('.substrate__verdict')).toBeHidden()
  await expect(window.locator('.monaco-editor .substrate-beam')).toHaveCount(0)
  await expect(beamLines()).toHaveCount(0)
})

test('raises no console errors', () => {
  expect(consoleProblems).toEqual([])
})
