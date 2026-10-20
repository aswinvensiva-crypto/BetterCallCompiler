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

/** The selected stage's pane, as opposed to the Source pane beside it. */
function projection() {
  return window.locator('.substrate__pane', { hasNot: window.locator('.substrate__source') })
}

function identifier(text: string) {
  return window.locator('.substrate__code .substrate-tk-id').filter({ hasText: new RegExp(`^${text}$`) })
}

/**
 * How far down the mirrored source is, whichever of its containers overflows;
 * with `toEnd`, scrolls it to the bottom first.
 */
function sourceScroll(toEnd = false): Promise<number> {
  return window.evaluate((end) => {
    type Scroller = { scrollTop: number; scrollHeight: number }
    const doc = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<Scroller> } }).document
    const scrollers = Array.from(doc.querySelectorAll('[data-scroll-key="source"], [data-scroll-key="source-pane"]'))
    if (end) for (const n of scrollers) n.scrollTop = n.scrollHeight
    return scrollers.reduce((sum, n) => sum + n.scrollTop, 0)
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

test('clicking below the fold keeps the source pane where it was', async () => {
  await openFile('long.bcc')
  await openSubstrate()

  expect(await sourceScroll(true)).toBeGreaterThan(0)

  // The click re-renders the whole view; the reader must not land back on line 1.
  await identifier('v80').click()
  await expect(window.locator('.substrate__trace-what')).toContainText('v80')
  expect(await sourceScroll()).toBeGreaterThan(0)
})

test('switching files does not carry the selection into the new one', async () => {
  await openFile('long.bcc')
  await openSubstrate()
  await identifier('v80').click()
  await expect(window.locator('.substrate__trace-what')).toContainText('v80')

  // v80 sits far past the end of valid.bcc. Carried over, that offset would
  // select nothing there; the trace should start afresh at the top instead.
  await openFile('valid.bcc')
  await expect(window.locator('.substrate__trace-what')).toContainText('Let total')
})

test('raises no console errors', () => {
  expect(consoleProblems).toEqual([])
})
