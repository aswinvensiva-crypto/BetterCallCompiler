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
 * The Observatory, end to end (BCC Part 11).
 *
 * Two claims are under test, and both have to survive the trip to the screen
 * rather than being true only at the protocol level:
 *
 *   1. Every stage the daemon builds — tokens, the AST, the scope tree, and
 *      per-function IR, SSA, passes and bytecode — actually renders, for a
 *      real `.bcc` file, through the real `compiler:observatory` channel.
 *   2. Spans threaded since Part 1 still mean something at the very end of
 *      the pipeline: clicking a line in the IR tab moves the caret in Monaco
 *      to the exact source line that instruction came from.
 *
 * `sum` is written with a loop and two accumulators specifically so mem2reg
 * has something to do — the SSA tab is uninteresting on straight-line code,
 * since nothing needs a phi until two definitions of the same variable meet.
 *
 * This spec owns `obs.bcc`, and the window is pinned to 1024x730, following
 * the convention every other BCC spec in this suite already does.
 */

const APP_ROOT = join(__dirname, '..', '..')
const MAIN_ENTRY = join(APP_ROOT, 'out', 'main', 'index.js')

const SOURCE = [
  'fn sum(n: int) -> int {', //     1
  '  let total = 0;', //            2
  '  let i = 0;', //                3
  '  while i < n {', //             4
  '    total = total + i;', //      5
  '    i = i + 1;', //              6
  '  }', //                         7
  '  return total;', //             8
  '}', //                           9
  '', //                           10
  'fn double(x: int) -> int {', // 11
  '  return x * 2;', //            12
  '}', //                          13
  '', //                           14
  'print sum(5);', //              15
  ''
].join('\n')

let fixture = ''
let app: ElectronApplication
let window: Page
const consoleProblems: string[] = []

const DAEMON_TIMEOUT = 25_000

test.beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'bcc-obs-'))
  await mkdir(join(fixture, 'examples'), { recursive: true })
  await writeFile(join(fixture, 'examples', 'obs.bcc'), SOURCE)

  app = await electron.launch({
    args: [MAIN_ENTRY, isolatedUserData('observatory'), `--folder=${fixture}`],
    cwd: APP_ROOT
  })
  window = await app.firstWindow()

  window.on('console', (message) => {
    if (message.type() === 'error') consoleProblems.push(`console.error: ${message.text()}`)
  })
  window.on('pageerror', (error) => consoleProblems.push(`pageerror: ${error.message}`))

  await window.waitForSelector('html[data-bettercallcompiler-ready="true"]')
  await (await app.browserWindow(window)).evaluate((browserWindow) => {
    browserWindow.setBounds({ x: 0, y: 0, width: 1024, height: 730 })
  })
  await expect
    .poll(() => window.evaluate(() => (globalThis as unknown as { innerWidth: number }).innerWidth))
    .toBeLessThan(1100)
})

test.afterAll(async () => {
  await app?.close()
  if (fixture !== '') await rm(fixture, { recursive: true, force: true })
})

function row(name: string) {
  return window.locator('.tree__row', { has: window.locator(`.tree__label:text-is("${name}")`) })
}

async function openObsFile(): Promise<void> {
  await row('examples').click()
  await row('obs.bcc').click()
  await expect(window.locator('.tab', { hasText: 'obs.bcc' })).toBeVisible()
}

async function openObservatory(): Promise<void> {
  const view = window.locator('.right-dock__view[data-view-id="observatory"]')
  // Clicking the activity item TOGGLES the right dock, so a second click on an
  // already-open view would close it — the same guard the other right-dock
  // specs in this suite use.
  if (!(await view.isVisible())) {
    await window.locator('.activity-bar__item[data-view-id="observatory"]').click()
  }
  await expect(view).toBeVisible()
}

function tab(label: string) {
  return window.locator('.obs-tabs__tab', { hasText: label })
}

function functionButton(name: string) {
  return window.locator('.obs-functions__item', { hasText: name })
}

const activeLineNumber = () => window.locator('.monaco-editor .active-line-number')

test.describe.configure({ mode: 'serial' })

test('opens in the right dock with all eight stages as tabs', async () => {
  await openObservatory()

  await expect(
    window.locator('.right-dock__title-slot[data-view-id="observatory"]')
  ).toContainText('Observatory')
  await expect(window.locator('.obs-tabs__tab')).toHaveCount(8)
  for (const label of ['Source', 'Tokens', 'AST', 'Symbols', 'IR', 'SSA', 'Passes', 'Bytecode']) {
    await expect(tab(label)).toBeVisible()
  }
})

test('says plainly that nothing is open yet, before any .bcc file is active', async () => {
  await expect(window.locator('.obs')).toContainText('open a .bcc file to inspect it')
})

test('the Source tab shows the file exactly as written, once opened', async () => {
  await openObsFile()
  await openObservatory()
  await tab('Source').click()

  await expect(window.locator('.obs-source')).toContainText('fn sum(n: int) -> int {')
  await expect(window.locator('.obs-source')).toContainText('fn double(x: int) -> int {')
})

test('the Tokens tab lists the token stream, keywords included', async () => {
  await tab('Tokens').click()
  const lines = window.locator('.obs-lines .obs-line')
  await expect(lines.first()).toBeVisible({ timeout: DAEMON_TIMEOUT })

  const text = await window.locator('.obs-lines').innerText()
  expect(text).toContain('fn')
  expect(text).toContain('identifier')
})

test('the AST tab shows the tree, one function per declaration', async () => {
  await tab('AST').click()
  const text = await window.locator('.obs-lines').innerText({ timeout: DAEMON_TIMEOUT })
  expect(text).toContain('Function sum')
  expect(text).toContain('Function double')
  expect(text).toContain('While')
})

test('the Symbols tab shows the scope tree with declared variables', async () => {
  await tab('Symbols').click()
  const text = await window.locator('.obs-lines').innerText({ timeout: DAEMON_TIMEOUT })
  expect(text).toContain('variable total')
  expect(text).toContain('function sum')
  expect(text).toContain('function double')
})

test('the IR tab is per function, and clicking a line reveals its exact source line', async () => {
  await tab('IR').click()
  await expect(functionButton('sum')).toBeVisible({ timeout: DAEMON_TIMEOUT })
  await expect(functionButton('double')).toBeVisible()

  await functionButton('double').click()
  const clickable = window.locator('.obs-lines .obs-line--clickable').first()
  await expect(clickable).toBeVisible()

  // The row's own title carries the line its span points at — read the claim
  // rather than assuming which line the IR happens to put first.
  const title = await clickable.getAttribute('title')
  const expectedLine = Number((title ?? '').replace(/[^0-9]/g, ''))
  expect(expectedLine).toBeGreaterThan(0)

  await clickable.click()
  await expect(activeLineNumber()).toHaveText(String(expectedLine))
})

test('the SSA tab shows a phi node for the loop’s accumulators', async () => {
  await tab('SSA').click()
  await functionButton('sum').click()

  const text = await window.locator('.obs-lines').innerText({ timeout: DAEMON_TIMEOUT })
  expect(text).toContain('phi')
})

test('the Passes tab lists Part 8’s four passes and can diff a changed one', async () => {
  await tab('Passes').click()
  await functionButton('sum').click()

  const passRows = window.locator('.obs-pass')
  await expect(passRows.first()).toBeVisible({ timeout: DAEMON_TIMEOUT })
  await expect(passRows).toHaveCount(4)

  const changed = window.locator('.obs-pass', { has: window.locator('.ci-tag--recomputed') }).first()
  await expect(changed).toBeVisible()
  await changed.locator('.obs-pass__diff').click()

  await expect(window.locator('#diff-surface')).toBeVisible()
  await expect(window.locator('.diff-surface__title')).not.toBeEmpty()

  // `dispatchEvent` rather than `.click()`: with a real `.bcc` file open behind
  // it, the diff surface's close button sits under the main editor's minimap
  // canvas for hit-testing purposes even though it paints on top — a
  // Monaco-versus-Monaco stacking quirk pre-existing this view (the diff
  // surface is shared with the SCM diff), not a click handler this test needs
  // to exercise. Dispatching the event directly reaches the real listener.
  await window.locator('.diff-surface .icon-button').dispatchEvent('click')
  await expect(window.locator('#diff-surface')).toBeHidden()
})

test('the Bytecode tab lists compiled instructions for the selected function', async () => {
  await tab('Bytecode').click()
  await functionButton('double').click()

  const text = await window.locator('.obs-lines').innerText({ timeout: DAEMON_TIMEOUT })
  expect(text).toContain('fn double')
  expect(text).toMatch(/binary|load|const/)
})

test('editing the file updates the snapshot without a reload', async () => {
  await tab('Source').click()
  await window.locator('.monaco-editor .view-lines').click()
  await window.keyboard.press('Control+End')
  await window.keyboard.type('\nfn tripled(x: int) -> int {\n  return x * 3;\n}\n')

  await tab('IR').click()
  await expect(functionButton('tripled')).toBeVisible({ timeout: DAEMON_TIMEOUT })

  // Undo the edit so this spec leaves the fixture the way the next run expects.
  await window.locator('.monaco-editor .view-lines').click()
  await window.keyboard.press('Control+z')
})

test('the whole session ran without a console error', async () => {
  expect(consoleProblems).toEqual([])
})
